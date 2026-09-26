// Client Score v1: a pure, deterministic scorer. No I/O, no clock reads (the
// caller passes `asOf`), no LLM.
//
// It doesn't care where payment data came from. Each paid invoice arrives as at
// most ONE normalized PaidTiming (see resolvePaidTimings.ts). The date's source
// is recorded only as an audit field in `inputs`, so it never changes the score.
//
// Components (all three always present; weights are never renormalized):
//   paymentHistory     .55  amount-weighted latenessScore over dated paid
//                           invoices (written_off = 0), blended with a PRIOR of
//                           70:  (n·mean + 70) / (n + 1).  n = 0 → 70.
//   currentDelinquency .30  latenessScore(max days past due) over open
//                           past-due invoices, excluding written_off. None → 100.
//   exposure           .15  100 × (1 − pastDueOutstanding / totalBilledNonDraft),
//                           with written_off left out of pastDueOutstanding.
// composite = round(Σ w·c); risk_level = bandFor(composite).
//
// Past-due status uses uiStatus()/daysFromToday() from lib/adapters.ts, so the
// score matches what the page shows. Every text line comes from real counts or
// amounts; the 70 prior is never presented as evidence.

import { uiStatus, daysFromToday } from "../adapters";
import type { Database, Json } from "../../types/supabase";
import {
  SCORER_VERSION,
  PRIOR,
  PROVISIONAL_MIN_DATED,
  WEIGHTS,
  bandFor,
  latenessScore,
  type RiskLevel,
} from "./scoreBands";
import { utcDate, type DateSource, type PaidTiming } from "./resolvePaidTimings";
import { daysBetweenUtcDates } from "./dates";

export type { PaidTiming } from "./resolvePaidTimings";
export type { RiskLevel } from "./scoreBands";

type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];

export interface ScoreInvoice {
  id: string;
  status: InvoiceStatus;
  due_date: string | null;
  issue_date: string | null;
  created_at: string;
  amount_cents: number;
  amount_outstanding_cents: number | null;
}

export interface PriorScore {
  composite_score: number | null;
  score_date: string;
}

export interface ScoreInputs {
  invoices: ScoreInvoice[];
  paidTimings: PaidTiming[];
  asOf: Date;
  prior?: PriorScore | null;
}

export type ComponentKey = keyof typeof WEIGHTS;
const COMPONENT_ORDER: ComponentKey[] = ["paymentHistory", "currentDelinquency", "exposure"];

export { SCORER_VERSION } from "./scoreBands";

// The ptr_scores fields the scorer produces (the route adds client_id and
// subscriber_id). Numbers are rounded to the live column scales:
// composite/payment_history numeric(5,2), avg_days_overdue numeric(6,2).
export interface ScoreRow {
  composite_score: number;
  risk_level: RiskLevel;
  payment_history_score: number;
  avg_days_overdue: number | null;
  non_response_rate: null; // responsiveness is v2
  outstanding_amount_cents: number;
  dispute_rate: null; // no source yet
  ai_model: null; // no LLM
  ai_recommendation: null;
  score_date: string; // YYYY-MM-DD (UTC)
  score_month: string; // YYYY-MM, the same format trg_ptr_score_month writes
  score_summary: string[];
  score_factors: string[];
  risk_drivers: string[];
  inputs: Json;
}

export type ScoreResult = { kind: "insufficient_data" } | ({ kind: "scored" } & ScoreRow);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function monthLabel(value: string): string {
  const d = new Date(value);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// $1,240.00 from cents. Formatted by hand so the output does not depend on ICU/locale.
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const c = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars}.${c}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Timing headlines need at least this many dated payments. With fewer, one late
// or on-time payment would decide the headline, so the timing-neutral set is used
// and the evidence stays visible in the "X of N dated payments" factor.
const TIMING_HEADLINE_MIN_DATED = 3;

// Used when there are >= TIMING_HEADLINE_MIN_DATED dated payments: these headlines describe payment timing.
const HEADLINE: Record<RiskLevel, string> = {
  low: "Reliable payer",
  medium: "Usually pays, sometimes late",
  high: "Frequently pays late",
  critical: "Severe collection risk",
};

// Used below TIMING_HEADLINE_MIN_DATED dated payments: these make no claim about timing.
const HEADLINE_TIMING_NEUTRAL: Record<RiskLevel, string> = {
  low: "Low collection risk",
  medium: "Moderate collection risk",
  high: "High collection risk",
  critical: "Severe collection risk",
};

interface TimingDetail {
  invoice_id: string;
  due_date: string;
  paid_date: string;
  date_source: DateSource;
  days_late: number;
  lateness_score: number;
  amount_cents: number;
}

export function computeClientScore(input: ScoreInputs): ScoreResult {
  const { asOf } = input;
  const invoices = [...input.invoices]
    .filter((inv) => inv.status !== "draft")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const totalBilledCents = invoices.reduce((s, inv) => s + inv.amount_cents, 0);
  if (invoices.length === 0 || totalBilledCents <= 0) return { kind: "insufficient_data" };

  // One timing per invoice. If a caller passes duplicates, the latest paid_date
  // wins (ties go to the smallest date_source) so the result doesn't depend on
  // input order.
  const timingByInvoice = new Map<string, PaidTiming>();
  for (const t of input.paidTimings) {
    const d = utcDate(t.paid_date);
    if (!d) continue;
    const cur = timingByInvoice.get(t.invoice_id);
    if (!cur || d > cur.paid_date || (d === cur.paid_date && t.date_source < cur.date_source)) {
      timingByInvoice.set(t.invoice_id, { ...t, paid_date: d });
    }
  }

  // ── Payment history.
  const timings: TimingDetail[] = [];
  let undatedPaid = 0;
  let noDueDate = 0;
  let writtenOff = 0;
  let writtenOffCents = 0;
  for (const inv of invoices) {
    if (inv.status === "written_off") {
      writtenOff += 1;
      writtenOffCents += inv.amount_cents;
      continue;
    }
    if (inv.status !== "paid") continue;
    const t = timingByInvoice.get(inv.id);
    if (!t) {
      undatedPaid += 1;
      continue;
    }
    const due = utcDate(inv.due_date);
    if (!due) {
      noDueDate += 1; // dated, but lateness can't be measured without a due date
      continue;
    }
    const days = daysBetweenUtcDates(due, t.paid_date) as number; // both are valid YMDs here
    timings.push({
      invoice_id: inv.id,
      due_date: due,
      paid_date: t.paid_date,
      date_source: t.date_source,
      days_late: days,
      lateness_score: latenessScore(days),
      amount_cents: inv.amount_cents,
    });
  }
  const datedPaid = timings.length;
  const n = datedPaid + writtenOff;
  const lateTimings = timings.filter((t) => t.days_late > 0);
  const onTime = datedPaid - lateTimings.length;

  // Amount-weighted mean over dated paid (their lateness score) + written_off (0).
  const weightCents = timings.reduce((s, t) => s + t.amount_cents, 0) + writtenOffCents;
  const weightedMean =
    n === 0
      ? PRIOR
      : weightCents > 0
        ? timings.reduce((s, t) => s + t.lateness_score * t.amount_cents, 0) / weightCents
        : timings.reduce((s, t) => s + t.lateness_score, 0) / n; // all zero-amount: plain mean
  const paymentHistory = n === 0 ? PRIOR : (n * weightedMean + PRIOR) / (n + 1);

  // ── Current delinquency + exposure (same past-due rule as the UI; written_off excluded).
  let pastDueCount = 0;
  let pastDueOutstandingCents = 0;
  let maxDaysPastDue = 0;
  let oldestOutstandingCents = 0;
  const pastDueDays: number[] = [];
  for (const inv of invoices) {
    if (inv.status === "written_off") continue;
    if (uiStatus(inv.status, inv.due_date, asOf) !== "past_due") continue;
    const outstanding = inv.amount_outstanding_cents ?? inv.amount_cents;
    pastDueCount += 1;
    pastDueOutstandingCents += outstanding;
    const delta = daysFromToday(inv.due_date, asOf);
    const days = delta !== null && delta < 0 ? Math.abs(delta) : 0;
    if (days > 0) pastDueDays.push(days);
    if (days > maxDaysPastDue || (days === maxDaysPastDue && outstanding > oldestOutstandingCents)) {
      maxDaysPastDue = days;
      oldestOutstandingCents = outstanding;
    }
  }
  const currentDelinquency = latenessScore(maxDaysPastDue);
  const exposure = Math.min(100, Math.max(0, 100 * (1 - pastDueOutstandingCents / totalBilledCents)));

  const components: Record<ComponentKey, number> = {
    paymentHistory: round(paymentHistory, 2),
    currentDelinquency,
    exposure: round(exposure, 2),
  };
  const composite = Math.round(
    COMPONENT_ORDER.reduce((s, k) => s + WEIGHTS[k] * components[k], 0),
  );
  const risk_level = bandFor(composite);
  const provisional = n < PROVISIONAL_MIN_DATED;

  const lateDays = [...lateTimings.map((t) => t.days_late), ...pastDueDays];
  const avgDaysOverdue =
    lateDays.length > 0
      ? Math.min(9999.99, round(lateDays.reduce((s, d) => s + d, 0) / lateDays.length, 2))
      : null;
  const avgLatePaidDays =
    lateTimings.length > 0
      ? Math.round(lateTimings.reduce((s, t) => s + t.days_late, 0) / lateTimings.length)
      : null;

  // ── Summary.
  const earliest = invoices
    .map((inv) => inv.issue_date ?? inv.created_at)
    .filter((v): v is string => !!v && !isNaN(new Date(v).getTime()))
    .sort()[0];
  const headline = (datedPaid >= TIMING_HEADLINE_MIN_DATED ? HEADLINE : HEADLINE_TIMING_NEUTRAL)[risk_level];

  const prior = input.prior;
  let trend: string;
  if (prior && prior.composite_score !== null) {
    const delta = composite - Math.round(prior.composite_score);
    const since = monthLabel(prior.score_date);
    trend =
      delta === 0
        ? `Unchanged since ${since}`
        : `${delta > 0 ? "Up" : "Down"} ${plural(Math.abs(delta), "point")} since ${since}`;
  } else {
    trend = earliest
      ? `Based on ${plural(invoices.length, "invoice")} since ${monthLabel(earliest)}`
      : `Based on ${plural(invoices.length, "invoice")}`;
  }

  const score_summary: string[] = [headline];
  if (undatedPaid > 0) {
    const undated = `${plural(undatedPaid, "paid invoice")} ${undatedPaid === 1 ? "has" : "have"} no payment date — not used in the score`;
    if (provisional) {
      score_summary.push(`${undated} (limited history)`, trend);
    } else {
      score_summary.push(trend, undated);
    }
  } else {
    score_summary.push(trend);
  }

  // ── Factors.
  const score_factors: string[] = [];
  if (datedPaid > 0) {
    score_factors.push(`${onTime} of ${plural(datedPaid, "dated payment")} ${datedPaid === 1 ? "was" : "were"} on time`);
  }
  // Paid-late invoices only. Open past-due age is covered by the "$X past due"
  // factor and the "Oldest open invoice" driver. The avg_days_overdue column keeps
  // its blended definition (late-paid + current past-due).
  if (avgLatePaidDays !== null) {
    score_factors.push(`Average delay: ${plural(avgLatePaidDays, "day")}`);
  }
  score_factors.push(
    pastDueCount > 0
      ? `${formatCents(pastDueOutstandingCents)} past due across ${plural(pastDueCount, "invoice")}`
      : "No invoices past due",
  );
  if (writtenOff > 0) {
    score_factors.push(`${plural(writtenOff, "invoice")} written off`);
  }
  if (score_factors.length < 2) {
    score_factors.push(`${formatCents(totalBilledCents)} billed across ${plural(invoices.length, "invoice")}`);
  }
  score_factors.splice(4);

  // ── Drivers: components below 70, lowest first. The history driver needs real
  // evidence (n > 0): a history at the 70 prior is never cited.
  const driverText: Record<ComponentKey, () => string | null> = {
    paymentHistory: () => {
      if (n === 0) return null;
      if (lateTimings.length > 0) {
        const base = `Paid ${lateTimings.length} of ${plural(n, "invoice")} late (avg ${plural(avgLatePaidDays as number, "day")})`;
        return writtenOff > 0 ? `${base}; ${writtenOff} written off` : base;
      }
      return writtenOff > 0 ? `${writtenOff} of ${plural(n, "invoice")} written off` : null;
    },
    currentDelinquency: () =>
      `Oldest open invoice is ${plural(maxDaysPastDue, "day")} past due (${formatCents(oldestOutstandingCents)})`,
    exposure: () =>
      `${Math.round((100 * pastDueOutstandingCents) / totalBilledCents)}% of billed amount is past due (${formatCents(pastDueOutstandingCents)})`,
  };
  const risk_drivers = COMPONENT_ORDER.filter((k) => components[k] < 70)
    // Lowest first; ties keep COMPONENT_ORDER (stable sort).
    .sort((a, b) => components[a] - components[b])
    .map((k) => driverText[k]())
    .filter((line): line is string => line !== null)
    .slice(0, 3);
  if (risk_drivers.length === 0) risk_drivers.push("No material risk drivers identified");

  const score_date = asOf.toISOString().slice(0, 10);
  const inputs: Json = {
    version: SCORER_VERSION,
    as_of: asOf.toISOString(),
    provisional,
    prior: PRIOR,
    weights: { ...WEIGHTS },
    components,
    timings: timings.map((t) => ({ ...t })),
    undated_paid_count: undatedPaid,
    detected_fallback_count: timings.filter((t) => t.date_source === "detected").length,
    no_due_date_count: noDueDate,
    aggregates: {
      non_draft_invoices: invoices.length,
      dated_paid: datedPaid,
      dated_paid_on_time: onTime,
      dated_paid_late: lateTimings.length,
      written_off: writtenOff,
      history_n: n,
      history_weighted_mean: round(weightedMean, 4),
      past_due_count: pastDueCount,
      past_due_outstanding_cents: pastDueOutstandingCents,
      past_due_days: pastDueDays,
      max_days_past_due: maxDaysPastDue,
      oldest_past_due_outstanding_cents: oldestOutstandingCents,
      total_billed_cents: totalBilledCents,
      prior_composite: prior?.composite_score ?? null,
      prior_score_date: prior?.score_date ?? null,
    },
  };

  return {
    kind: "scored",
    composite_score: composite,
    risk_level,
    payment_history_score: components.paymentHistory,
    avg_days_overdue: avgDaysOverdue,
    non_response_rate: null,
    outstanding_amount_cents: pastDueOutstandingCents,
    dispute_rate: null,
    ai_model: null,
    ai_recommendation: null,
    score_date,
    score_month: score_date.slice(0, 7),
    score_summary,
    score_factors,
    risk_drivers,
    inputs,
  };
}

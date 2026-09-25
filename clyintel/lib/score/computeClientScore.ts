// Client Score v0: a pure, deterministic scorer. No I/O and no clock reads
// (the caller passes `asOf`). No LLM.
//
// Input: a client's invoices, the paid_at timings of their succeeded payments, the
// client's communications, and optionally the prior month's score. Output: either
// { kind: "insufficient_data" } (no non-draft invoices) or a ScoreResult holding
// every ptr_scores field the route writes, plus deterministic explanation lines.
//
// Components (each 0–100, or null when its data is absent):
//   paymentHistory     w .40  on-time rate over paid invoices with a known paid_at
//                             (written_off counts as paid late)
//   currentDelinquency w .30  banded max days past due among past-due invoices
//   exposure           w .15  100 × (1 − pastDueOutstanding / totalBilledNonDraft)
//   responsiveness     w .15  reply rate over outbound communications
// composite = round(weighted mean over the NON-null components, weights renormalized).
//
// Past-due status uses uiStatus()/daysFromToday() from lib/adapters.ts, the same
// helpers the UI renders with, so the score matches the page.
//
// Every text line is built from a count or amount in `inputs`. A line whose data
// is missing is omitted, never invented.

import { uiStatus, daysFromToday } from "../adapters";
import type { Database, Json } from "../../types/supabase";

type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];
type Direction = Database["public"]["Enums"]["communication_direction"];
export type RiskLevel = Database["public"]["Enums"]["ptr_risk_level"];

export interface ScoreInvoice {
  id: string;
  status: InvoiceStatus;
  due_date: string | null;
  issue_date: string | null;
  created_at: string;
  amount_cents: number;
  amount_outstanding_cents: number | null;
}

// One row per succeeded payment allocated to an invoice (invoice_payments → payments).
export interface PaidTiming {
  invoice_id: string;
  paid_at: string | null;
}

export interface ScoreComm {
  invoice_id: string | null;
  direction: Direction;
  sent_at: string | null;
  created_at: string;
  reply_received_at: string | null;
}

export interface PriorScore {
  composite_score: number | null;
  score_date: string;
}

export interface ScoreInputs {
  invoices: ScoreInvoice[];
  paidTimings: PaidTiming[];
  comms: ScoreComm[];
  asOf: Date;
  prior?: PriorScore | null;
}

export const WEIGHTS = {
  paymentHistory: 0.4,
  currentDelinquency: 0.3,
  exposure: 0.15,
  responsiveness: 0.15,
} as const;

export type ComponentKey = keyof typeof WEIGHTS;
const COMPONENT_ORDER: ComponentKey[] = [
  "paymentHistory",
  "currentDelinquency",
  "exposure",
  "responsiveness",
];

export const SCORER_VERSION = "client-score-v0";

// The ptr_scores fields the scorer produces (client_id / subscriber_id are added
// by the route). Numeric values are rounded to the live column scales:
// composite/payment_history numeric(5,2), avg_days_overdue numeric(6,2),
// non_response_rate numeric(5,4).
export interface ScoreRow {
  composite_score: number;
  risk_level: RiskLevel;
  payment_history_score: number | null;
  avg_days_overdue: number | null;
  non_response_rate: number | null;
  outstanding_amount_cents: number;
  dispute_rate: null; // no source in v0
  ai_model: null; // v0 has no LLM
  ai_recommendation: null;
  score_date: string; // YYYY-MM-DD (UTC)
  score_month: string; // YYYY-MM, same format trg_ptr_score_month writes
  score_summary: string[];
  score_factors: string[];
  risk_drivers: string[];
  inputs: Json;
}

export type ScoreResult = { kind: "insufficient_data" } | ({ kind: "scored" } & ScoreRow);

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// "YYYY-MM-DD" (UTC) for a timestamp or date string; null when unparseable.
function utcDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function dayDiff(laterYmd: string, earlierYmd: string): number {
  return Math.round((Date.parse(laterYmd) - Date.parse(earlierYmd)) / MS_PER_DAY);
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

export function riskLevelFor(composite: number): RiskLevel {
  if (composite >= 80) return "low";
  if (composite >= 60) return "medium";
  if (composite >= 40) return "high";
  return "critical";
}

// Used only when paymentHistory is non-null: these lines describe payment timing.
const HEADLINE: Record<RiskLevel, string> = {
  low: "Reliable payer",
  medium: "Pays, but often late",
  high: "Elevated collection risk",
  critical: "Severe collection risk",
};

// Used when paymentHistory is null: nothing is known about payment timing, so the
// headline must not claim anything about it.
const HEADLINE_TIMING_NEUTRAL: Record<RiskLevel, string> = {
  low: "Low collection risk",
  medium: "Moderate collection risk",
  high: "Elevated collection risk",
  critical: "Severe collection risk",
};

export function delinquencyBand(maxDaysPastDue: number): number {
  if (maxDaysPastDue <= 0) return 100;
  if (maxDaysPastDue <= 15) return 80;
  if (maxDaysPastDue <= 30) return 60;
  if (maxDaysPastDue <= 60) return 35;
  if (maxDaysPastDue <= 90) return 15;
  return 0;
}

// Weighted mean over the non-null components, weights renormalized to sum to 1.
export function compositeFrom(components: Record<ComponentKey, number | null>): {
  composite: number;
  weightsUsed: Partial<Record<ComponentKey, number>>;
} {
  const present = COMPONENT_ORDER.filter((k) => components[k] !== null);
  const total = present.reduce((s, k) => s + WEIGHTS[k], 0);
  const weightsUsed: Partial<Record<ComponentKey, number>> = {};
  let acc = 0;
  for (const k of present) {
    const w = WEIGHTS[k] / total;
    weightsUsed[k] = round(w, 4);
    acc += w * (components[k] as number);
  }
  return { composite: Math.round(acc), weightsUsed };
}

export function computeClientScore(input: ScoreInputs): ScoreResult {
  const { asOf } = input;
  const invoices = input.invoices.filter((inv) => inv.status !== "draft");
  if (invoices.length === 0) return { kind: "insufficient_data" };

  // ── Paid timing: an invoice counts as paid when its LAST succeeded payment landed.
  const lastPaidAt = new Map<string, string>();
  for (const t of input.paidTimings) {
    const ymd = utcDate(t.paid_at);
    if (!ymd) continue;
    const cur = lastPaidAt.get(t.invoice_id);
    if (!cur || ymd > cur) lastPaidAt.set(t.invoice_id, ymd);
  }

  let paidWithTiming = 0;
  let paidLate = 0;
  const paidLateDays: number[] = [];
  let writtenOff = 0;
  for (const inv of invoices) {
    if (inv.status === "written_off") {
      writtenOff += 1;
      continue;
    }
    if (inv.status !== "paid") continue;
    const paid = lastPaidAt.get(inv.id);
    const due = utcDate(inv.due_date);
    if (!paid || !due) continue; // unknown timing: excluded, not guessed
    paidWithTiming += 1;
    if (paid > due) {
      paidLate += 1;
      paidLateDays.push(dayDiff(paid, due));
    }
  }
  const historyN = paidWithTiming + writtenOff;
  const historyLate = paidLate + writtenOff;
  const paymentHistory = historyN > 0 ? (100 * (historyN - historyLate)) / historyN : null;

  // ── Current delinquency + exposure (same past-due rule as the UI).
  let pastDueCount = 0;
  let pastDueOutstandingCents = 0;
  let maxDaysPastDue = 0;
  const pastDueDays: number[] = [];
  let totalBilledCents = 0;
  for (const inv of invoices) {
    totalBilledCents += inv.amount_cents;
    if (uiStatus(inv.status, inv.due_date, asOf) !== "past_due") continue;
    pastDueCount += 1;
    pastDueOutstandingCents += inv.amount_outstanding_cents ?? inv.amount_cents;
    const delta = daysFromToday(inv.due_date, asOf);
    const days = delta !== null && delta < 0 ? Math.abs(delta) : 0;
    if (days > 0) pastDueDays.push(days);
    maxDaysPastDue = Math.max(maxDaysPastDue, days);
  }
  const currentDelinquency = delinquencyBand(maxDaysPastDue);
  const exposure =
    totalBilledCents > 0
      ? Math.min(100, Math.max(0, 100 * (1 - pastDueOutstandingCents / totalBilledCents)))
      : null;

  // ── Responsiveness.
  const inboundInvoices = new Set(
    input.comms.filter((c) => c.direction === "inbound" && c.invoice_id).map((c) => c.invoice_id as string),
  );
  const outbound = input.comms
    .filter((c) => c.direction === "outbound")
    .map((c) => ({
      at: c.sent_at ?? c.created_at,
      replied: c.reply_received_at !== null || (c.invoice_id !== null && inboundInvoices.has(c.invoice_id)),
    }))
    // Newest first; ties broken by reply flag so ordering is fully deterministic.
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : Number(a.replied) - Number(b.replied)));
  const outboundCount = outbound.length;
  const repliedCount = outbound.filter((o) => o.replied).length;
  let unansweredStreak = 0;
  for (const o of outbound) {
    if (o.replied) break;
    unansweredStreak += 1;
  }
  const responsiveness = outboundCount > 0 ? (100 * repliedCount) / outboundCount : null;

  const components: Record<ComponentKey, number | null> = {
    paymentHistory: paymentHistory === null ? null : round(paymentHistory, 2),
    currentDelinquency,
    exposure: exposure === null ? null : round(exposure, 2),
    responsiveness: responsiveness === null ? null : round(responsiveness, 2),
  };
  const { composite, weightsUsed } = compositeFrom(components);
  const risk_level = riskLevelFor(composite);

  const lateDays = [...paidLateDays, ...pastDueDays];
  const avgDaysOverdue =
    lateDays.length > 0
      ? Math.min(9999.99, round(lateDays.reduce((s, d) => s + d, 0) / lateDays.length, 2))
      : null;
  const nonResponseRate = outboundCount > 0 ? round(1 - repliedCount / outboundCount, 4) : null;

  // ── Text lines.
  const earliest = invoices
    .map((inv) => inv.issue_date ?? inv.created_at)
    .filter((v): v is string => !!v && !isNaN(new Date(v).getTime()))
    .sort()[0];

  const headlines = components.paymentHistory === null ? HEADLINE_TIMING_NEUTRAL : HEADLINE;
  const score_summary: string[] = [headlines[risk_level]];
  const prior = input.prior;
  if (prior && prior.composite_score !== null) {
    const delta = composite - Math.round(prior.composite_score);
    const since = monthLabel(prior.score_date);
    score_summary.push(
      delta === 0
        ? `Unchanged since ${since}`
        : `${delta > 0 ? "Up" : "Down"} ${plural(Math.abs(delta), "point")} since ${since}`,
    );
  } else {
    score_summary.push(
      earliest
        ? `Based on ${plural(invoices.length, "invoice")} since ${monthLabel(earliest)}`
        : `Based on ${plural(invoices.length, "invoice")}`,
    );
  }
  if (components.paymentHistory === null) {
    score_summary.push("Payment timing not scored: no payment dates on record");
  }
  if (components.responsiveness === null) {
    score_summary.push("Responsiveness not scored: no outreach sent yet");
  }

  const score_factors: string[] = [];
  if (paidWithTiming > 0) {
    score_factors.push(`${paidLate} of ${plural(paidWithTiming, "paid invoice")} ${paidWithTiming === 1 ? "was" : "were"} late`);
  }
  score_factors.push(
    pastDueCount > 0
      ? `${formatCents(pastDueOutstandingCents)} past due across ${plural(pastDueCount, "invoice")}`
      : "No invoices past due",
  );
  if (avgDaysOverdue !== null) {
    score_factors.push(`Average delay: ${plural(Math.round(avgDaysOverdue), "day")}`);
  }
  if (outboundCount > 0) {
    score_factors.push(`Replied to ${repliedCount} of ${plural(outboundCount, "outreach message")}`);
  }
  if (writtenOff > 0) {
    score_factors.push(`${plural(writtenOff, "invoice")} written off`);
  }
  if (score_factors.length < 2) {
    score_factors.push(`${formatCents(totalBilledCents)} billed across ${plural(invoices.length, "invoice")}`);
  }
  score_factors.splice(4);

  const driverText: Record<ComponentKey, () => string> = {
    paymentHistory: () => {
      if (paidWithTiming === 0) return `${plural(writtenOff, "invoice")} written off as uncollectible`;
      const base = `Paid ${paidLate} of ${plural(paidWithTiming, "invoice")} after the due date`;
      return writtenOff > 0 ? `${base}; ${writtenOff} written off` : base;
    },
    currentDelinquency: () => `Oldest open invoice is ${plural(maxDaysPastDue, "day")} past due`,
    exposure: () =>
      `${Math.round((100 * pastDueOutstandingCents) / totalBilledCents)}% of billed amount is past due (${formatCents(pastDueOutstandingCents)})`,
    responsiveness: () =>
      unansweredStreak >= 2
        ? `No replies to the last ${unansweredStreak} outreach attempts`
        : `Replied to only ${repliedCount} of ${plural(outboundCount, "outreach message")}`,
  };
  const weak = COMPONENT_ORDER.filter((k) => components[k] !== null && (components[k] as number) < 80)
    // Lowest first; ties keep COMPONENT_ORDER (stable sort).
    .sort((a, b) => (components[a] as number) - (components[b] as number))
    .slice(0, 3);
  const risk_drivers =
    weak.length > 0 ? weak.map((k) => driverText[k]()) : ["No material risk drivers identified"];

  const score_date = asOf.toISOString().slice(0, 10);
  const inputs: Json = {
    version: SCORER_VERSION,
    as_of: asOf.toISOString(),
    weights: { ...WEIGHTS },
    weights_used: weightsUsed,
    components,
    aggregates: {
      non_draft_invoices: invoices.length,
      paid_with_timing: paidWithTiming,
      paid_late: paidLate,
      paid_late_days: paidLateDays,
      written_off: writtenOff,
      past_due_count: pastDueCount,
      past_due_outstanding_cents: pastDueOutstandingCents,
      past_due_days: pastDueDays,
      max_days_past_due: maxDaysPastDue,
      total_billed_cents: totalBilledCents,
      outbound_count: outboundCount,
      replied_count: repliedCount,
      unanswered_streak: unansweredStreak,
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
    non_response_rate: nonResponseRate,
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

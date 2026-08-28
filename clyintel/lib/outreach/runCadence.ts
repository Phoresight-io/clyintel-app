import type { SendEmailStepContext } from "@/lib/outreach/sendEmailStep";

// Cadence trigger engine (Brick 1c) — PURE, deterministic, injected clock + Port.
//
// Per invocation, for each candidate invoice, the engine walks the cadence
// definition and, if today's step is due and not already recorded, calls
// sendEmailStep in DRY-RUN and records one progress row. It sends nothing and
// registers no cron. Same testability convention as sendEmailStep: no I/O and no
// clock in this module — `now` is injected, all DB access goes through a Port.
//
// It SUPERSEDES lib/outreach/eligibility.ts's selection and must NOT call it:
//   - eligibility.ts: past-due = `due_date < now` at TIMESTAMP granularity; one
//     attempt per invoice ever; writes a SIMULATION recovery_attempts row directly.
//   - runCadence:      past-due = `due_date < today` at DATE granularity (below);
//     business-day cadence entry; a multi-step walk; terminus-checked first; and it
//     drives sendEmailStep (real recorded dry-run rows), never SIMULATION rows.
// The old SIMULATION rows remain as historical artifacts; this engine ignores them.

// ── Canonical "today" — UTC SEAM (grounded 2026-08-27) ───────────────────────
// Past-due at DATE granularity needs a defined "today", and "today" is timezone-
// dependent. There is NO subscribers.timezone (or any timezone) column in the DB
// today, so "today" is the UTC calendar date. This is a REAL SEAM: an invoice due
// "today" is past-due at a different wall-clock instant in Boston vs. LA, so a
// UTC "today" can dun a subscriber up to a day early near their local midnight.
// Acceptable for 1c (dry-run — nothing is sent); MUST be revisited before live
// send by grounding a real subscriber timezone. Do NOT invent a column here.
export function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ── Terminus (checked FIRST, before any step) ────────────────────────────────
// Terminal statuses. `written_off` is terminal NOW even though nothing sets it yet
// (seam b respected forward): decide the boundary once, at the first thing to act
// on it.
const TERMINAL_STATUSES = new Set(["paid", "written_off"]);

/**
 * True when the invoice must NOT be dunned. Fail-closed on any anomaly — a
 * status/outstanding disagreement, or a missing outstanding, is treated as
 * terminated rather than risk dunning a bad row:
 *   - status in {paid, written_off}                          → terminated
 *   - amount_outstanding_cents is null (can't confirm a debt) → terminated
 *   - amount_outstanding_cents <= 0 (nothing owed)            → terminated
 * A non-terminal status with outstanding 0, or a terminal status with outstanding
 * > 0, both resolve to terminated via the two checks above.
 */
export function isTerminated(inv: {
  status: string;
  amount_outstanding_cents: number | null;
}): boolean {
  if (TERMINAL_STATUSES.has(inv.status)) return true;
  if (inv.amount_outstanding_cents == null) return true;
  if (inv.amount_outstanding_cents <= 0) return true;
  return false;
}

// ── Past-due at DATE granularity (canonical convention) ──────────────────────
// due_date STRICTLY before today → past due. `due_date == today` is NOT yet past
// due (this closes the ledger's `due==today` item). Null due_date → not past due
// (fail closed, same posture as eligibility.ts). due_date is a DATE column, so it
// arrives as 'YYYY-MM-DD'; lexicographic compare of ISO dates is chronological.
export function isPastDue(dueDate: string | null, today: string): boolean {
  if (!dueDate) return false;
  return dueDate.slice(0, 10) < today;
}

// ── Business-day date math (UTC; no helper existed in the repo) ───────────────
// Holiday calendar is DEFERRED (seam d): only Sat/Sun are skipped. Dates are
// handled at UTC midnight so no DST shift can move a calendar date.
function parseUtc(dateStr: string): Date {
  return new Date(dateStr.slice(0, 10) + "T00:00:00.000Z");
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isWeekend(d: Date): boolean {
  const day = d.getUTCDay(); // 0 = Sun … 6 = Sat
  return day === 0 || day === 6;
}

/** First business day STRICTLY after `dateStr` (Sat/Sun skipped). */
export function nextBusinessDay(dateStr: string): string {
  const d = parseUtc(dateStr);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (isWeekend(d));
  return fmt(d);
}

/** Add `n` business days to `startStr` (n >= 0). `start` is assumed a business
 *  day (cadence entry always is); n = 0 returns the start date unchanged. */
export function addBusinessDays(startStr: string, n: number): string {
  const d = parseUtc(startStr);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) added++;
  }
  return fmt(d);
}

// ── Cadence types ────────────────────────────────────────────────────────────
export interface CadenceStepDef {
  step_number: number;
  channel: string; // communication_channel; 1c executes 'email' only (seam below)
  offset_business_days: number;
}
export interface CadenceDef {
  id: string;
  steps: CadenceStepDef[];
}
export interface CadenceInvoice {
  id: string;
  subscriber_id: string;
  client_id: string;
  status: string;
  due_date: string | null;
  amount_outstanding_cents: number | null;
}

/**
 * The single step to fire this invocation, or null. Rule: the FIRST unrecorded
 * step gates — if it is due (its computed due date <= today) fire it, otherwise
 * fire nothing. We never advance past a step that has not fired, and never return
 * more than one step, so a caller can fire at most one step per invoice per run.
 * A step whose number is already recorded is skipped (never re-run).
 */
export function selectDueStep(
  cadence: CadenceDef,
  entryDate: string,
  recorded: ReadonlySet<number>,
  today: string,
): CadenceStepDef | null {
  const ordered = [...cadence.steps].sort((a, b) => a.step_number - b.step_number);
  for (const step of ordered) {
    if (recorded.has(step.step_number)) continue; // already fired → look past it
    const dueDate = addBusinessDays(entryDate, step.offset_business_days);
    return today >= dueDate ? step : null; // first unrecorded step gates
  }
  return null; // every step recorded → cadence complete
}

// ── Port (all I/O; the real impl lives in the route, fakes in tests) ──────────
export type RunSendResult = {
  outcome: string; // sendEmailStep's outcome (would_send on the dry-run happy path)
  communicationId: string | null;
  recoveryAttemptId: string | null;
};

export interface RunCadencePort {
  loadActiveCadence(): Promise<CadenceDef | null>;
  loadCandidateInvoices(): Promise<CadenceInvoice[]>;
  loadRecordedStepNumbers(invoiceId: string): Promise<number[]>;
  // Hard-wired to sendEmailStep(ctx, "dry_run") in the real port — 1c has NO live
  // path. The engine only ever asks the port to "run the send step"; the dry-run
  // wiring is the port's responsibility so it cannot leak a live send in here.
  runSendStep(ctx: SendEmailStepContext): Promise<RunSendResult>;
  recordProgress(row: {
    subscriber_id: string;
    invoice_id: string;
    cadence_id: string;
    step_number: number;
    communication_id: string | null;
    recovery_attempt_id: string | null;
  }): Promise<void>;
}

export type InvoiceDisposition =
  | "terminated"
  | "not_past_due"
  | "no_step_due"
  | "unsupported_channel"
  | "fired"
  | "skipped_no_artifact";

export interface CadenceRunSummary {
  today: string;
  cadenceId: string | null;
  considered: number;
  terminated: number;
  notPastDue: number;
  noStepDue: number;
  unsupportedChannel: number;
  fired: number;
  skippedNoArtifact: number;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function runCadence(
  now: Date,
  port: RunCadencePort,
): Promise<CadenceRunSummary> {
  const today = utcToday(now);
  const summary: CadenceRunSummary = {
    today,
    cadenceId: null,
    considered: 0,
    terminated: 0,
    notPastDue: 0,
    noStepDue: 0,
    unsupportedChannel: 0,
    fired: 0,
    skippedNoArtifact: 0,
  };

  const cadence = await port.loadActiveCadence();
  if (!cadence) return summary; // nothing to walk — engine no-ops cleanly
  summary.cadenceId = cadence.id;

  const invoices = await port.loadCandidateInvoices();
  for (const inv of invoices) {
    summary.considered++;

    // 1. Terminus FIRST — before any step, never advance a terminated invoice.
    if (isTerminated(inv)) {
      summary.terminated++;
      continue;
    }
    // 2. Past-due at DATE granularity (due==today is NOT past due).
    if (!isPastDue(inv.due_date, today)) {
      summary.notPastDue++;
      continue;
    }
    // 3. Entry = next business day after the due date (Sat/Sun skipped).
    const entry = nextBusinessDay(inv.due_date as string); // non-null: past-due ⇒ set
    // 4. The one step due this invocation (or none).
    const recorded = new Set(await port.loadRecordedStepNumbers(inv.id));
    const step = selectDueStep(cadence, entry, recorded, today);
    if (!step) {
      summary.noStepDue++;
      continue;
    }
    // 1c executes EMAIL steps only. A non-email step has no send brick yet, so the
    // engine leaves it unrecorded (the cadence intentionally stalls there until the
    // sms/voice send brick lands). The seeded default is email-only, so this is a
    // forward-looking guard, not a live path.
    if (step.channel !== "email") {
      summary.unsupportedChannel++;
      continue;
    }

    // 5. Run the send step (DRY-RUN, via the port) and record progress.
    const res = await port.runSendStep({
      subscriberId: inv.subscriber_id,
      clientId: inv.client_id,
      invoiceId: inv.id,
    });

    // Record ONLY when the step actually produced a dry-run artifact. A contactless
    // / channel-denied / misconfigured invoice yields no artifact → clean skip, no
    // progress row, no advance (it is retried next run and still writes nothing).
    // NOTE: run-then-record leaves a tiny window where a would_send row exists but
    // its progress row is not yet written; a duplicate would be a harmless second
    // dry-run row (nothing is sent). Row-claim-before-send hardening is deferred,
    // same posture as the qbo/worker row-locking TODO.
    if (res.outcome === "would_send" || res.outcome === "sent") {
      await port.recordProgress({
        subscriber_id: inv.subscriber_id,
        invoice_id: inv.id,
        cadence_id: cadence.id,
        step_number: step.step_number,
        communication_id: res.communicationId,
        recovery_attempt_id: res.recoveryAttemptId,
      });
      summary.fired++;
    } else {
      summary.skippedNoArtifact++;
    }
  }

  return summary;
}

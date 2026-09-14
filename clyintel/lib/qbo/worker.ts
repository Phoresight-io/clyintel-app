import { timingSafeEqual } from "crypto";
import type { CaptureEvent } from "../capture/captureEvent";
import type { CaptureResult } from "../capture/captureResult";
import type { ReconcileInput, ReconcileResult } from "./reconcileInvoiceFromCapture";

// Testable logic for the webhook-events worker (the HTTP handler in
// app/api/qbo/worker/route.ts wires the real collaborators into these). Kept
// free of `@/` imports and I/O so alias-less vitest can load it directly.

// ---------------------------------------------------------------------------
// Cron auth guard
// ---------------------------------------------------------------------------

export type CronAuthResult = "ok" | "missing_secret" | "unauthorized";

/**
 * Guard for the worker endpoint. Requires `Authorization: Bearer <secret>` and
 * a constant-time compare. A missing secret env is a misconfiguration
 * ('missing_secret' → the route returns 500) — never run unguarded. A missing
 * or mismatched header → 'unauthorized' (401, no work done).
 */
export function checkCronAuth(
  authHeader: string | null | undefined,
  secret: string | null | undefined,
): CronAuthResult {
  if (!secret) return "missing_secret";
  if (!authHeader) return "unauthorized";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return "unauthorized"; // length guard before timingSafeEqual
  return timingSafeEqual(a, b) ? "ok" : "unauthorized";
}

// ---------------------------------------------------------------------------
// QBO payload → qualifying Payment entities
// ---------------------------------------------------------------------------

export interface PaymentEntityRef {
  realmId: string;
  paymentId: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Extract qualifying Payment entities from a verified QBO webhook body. Walks
 * `eventNotifications[].dataChangeEvent.entities[]`, keeping entities whose
 * `name === 'Payment'` and `operation` is 'Create' or 'Update'. Invoice
 * entities, Delete/void ops, and other names are skipped.
 */
export function parseQboPaymentEntities(rawPayload: unknown): PaymentEntityRef[] {
  const out: PaymentEntityRef[] = [];
  const root = asRecord(rawPayload);
  if (!root) return out;

  const notifications = root.eventNotifications;
  if (!Array.isArray(notifications)) return out;

  for (const rawNote of notifications) {
    const note = asRecord(rawNote);
    if (!note) continue;
    const realmId = note.realmId;
    const dce = asRecord(note.dataChangeEvent);
    const entities = dce?.entities;
    if (typeof realmId !== "string" || !Array.isArray(entities)) continue;

    for (const rawEntity of entities) {
      const entity = asRecord(rawEntity);
      if (!entity) continue;
      const { name, operation, id } = entity;
      if (
        name === "Payment" &&
        (operation === "Create" || operation === "Update") &&
        typeof id === "string"
      ) {
        out.push({ realmId, paymentId: id });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result summary (compact text for the webhook_events.result column)
// ---------------------------------------------------------------------------

export function summarizeResult(result: CaptureResult): string {
  switch (result.status) {
    case "written":
      return "written";
    case "duplicate":
      return "duplicate";
    case "no_fee":
      return `no_fee:${result.reason}`;
    case "rejected":
      return `rejected:${result.reason}`;
  }
}

// ---------------------------------------------------------------------------
// Per-row state machine
// ---------------------------------------------------------------------------

/** A source's wiring: how to parse its payload, how to build a CaptureEvent (+
 *  its sibling reconcileInput), and how to reconcile the local invoice. */
export interface RowHandler {
  parseEntities(rawPayload: unknown): PaymentEntityRef[];
  buildEvent(
    realmId: string,
    paymentId: string,
  ): Promise<{ event: CaptureEvent; reconcileInput: ReconcileInput }>;
  /**
   * Reconcile the local operational tables to the captured payment. Called AFTER
   * a non-'rejected' capture. Optional: a source with no local invoice to
   * reconcile omits it. Its failure propagates (retried like any row error) —
   * capture and reconcile are both idempotent, so a retry is safe.
   */
  reconcile?(input: ReconcileInput): Promise<ReconcileResult>;
}

export interface WebhookEventRow {
  id: string;
  source: string;
  raw_payload: unknown;
  attempts: number;
}

/** The subset of columns the worker writes back to the claimed row. */
export interface RowUpdate {
  status: "done" | "failed" | "dead";
  attempts?: number;
  last_error?: string;
  result?: string;
  processed_at?: string;
}

export interface RowProcessDeps {
  /** Source slug → handler. Unknown source → thrown error → failure path. */
  handlers: Record<string, RowHandler>;
  runCore: (event: CaptureEvent) => Promise<CaptureResult>;
  nowIso: () => string;
}

export interface RowProcessOutput {
  update: RowUpdate;
  /** Per-entity outcome summaries (for observability counts); [] on failure. */
  outcomes: string[];
}

const MAX_ATTEMPTS = 3;

/**
 * Run one claimed webhook_events row through the pipeline and compute its
 * mark-back. Business rejections (no_fee/rejected/duplicate) are NOT failures —
 * they resolve to `done`. Only a THROWN exception increments attempts and
 * drives failed→dead. Caller applies `update` to the row.
 */
export async function processWebhookEventRow(
  row: WebhookEventRow,
  deps: RowProcessDeps,
): Promise<RowProcessOutput> {
  const { handlers, runCore, nowIso } = deps;
  try {
    const handler = handlers[row.source];
    if (!handler) {
      throw new Error(`unknown source '${row.source}'`);
    }

    const entities = handler.parseEntities(row.raw_payload);
    if (entities.length === 0) {
      // Handled correctly — e.g. an Invoice-only payload. Not a failure.
      const result = "skipped:no_payment_entity";
      return { update: { status: "done", result, processed_at: nowIso() }, outcomes: [result] };
    }

    const outcomes: string[] = [];
    for (const { realmId, paymentId } of entities) {
      const { event, reconcileInput } = await handler.buildEvent(realmId, paymentId);
      const result = await runCore(event);
      outcomes.push(summarizeResult(result));

      // Reconcile the local invoice to reality on any capture that isn't
      // 'rejected' (written / duplicate / no_fee): the payment landed in QBO
      // regardless of whether we earned a fee, so the invoice state — which is
      // independent of fee outcome — must reflect it. 'rejected' means the
      // source/subscriber didn't resolve, so there's nothing trustworthy to
      // write; skip it. reconcileInput is populated in every branch here
      // (buildEvent ran to completion before runCore), so no branch lacks it.
      if (result.status !== "rejected" && handler.reconcile) {
        const rec = await handler.reconcile(reconcileInput);
        outcomes.push(`reconcile:${rec.status}`);
      }
    }
    return { update: { status: "done", result: outcomes.join(";"), processed_at: nowIso() }, outcomes };
  } catch (err) {
    // Any thrown exception (QBO API error, adapter throw, DB throw, unknown
    // source) → retry/dead. Message only — never tokens/secrets.
    const message = err instanceof Error ? err.message : String(err);
    const attempts = row.attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      return { update: { status: "failed", attempts, last_error: message }, outcomes: [] };
    }
    return {
      update: { status: "dead", attempts, last_error: message, processed_at: nowIso() },
      outcomes: [],
    };
  }
}

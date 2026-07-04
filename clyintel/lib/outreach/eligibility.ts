// Outreach eligibility engine (Brick A) — pure, deterministic, dependency-free.
//
// Given a subscriber's QBO invoices + clients + the set of invoices already
// attempted, decide which past-due, contactable invoices earn a recovery_attempts
// row, and return the rows to insert. It performs NO I/O and reads no clock — the
// reference `now` is injected so it is unit-testable with zero mocking (same
// convention as lib/revshare/accrualLedger.ts).
//
// Option B (stub-send): the returned rows carry sent_at + status='sent' WITHOUT a
// real send. They are unmistakably marked as simulations (notes = SIMULATION_NOTE,
// communication_id = null) so a real-send brick can find and replace every one.
//
// NON-NEGOTIABLE: invoice_id on the row is the LOCAL invoices.id (uuid), never the
// QBO external_id — the capture gate resolves sourceInvoiceId → local uuid and then
// matches recovery_attempts.invoice_id, so writing external_id would make the row
// exist yet never satisfy the gate.

// Marker that makes a stub row unmistakable and queryable. A real-send brick finds
// every simulation with: where notes = 'SIMULATION—BRICK-A-V1—NO_REAL_SEND'.
export const SIMULATION_NOTE = "SIMULATION—BRICK-A-V1—NO_REAL_SEND";

// Minimal structural inputs (no supabase/type imports → alias-free, zero-mock).
export interface EligInvoice {
  id: string; // LOCAL invoices.id (uuid) — this is what the row's invoice_id must be
  subscriber_id: string;
  client_id: string;
  due_date: string | null;
}

export interface EligClient {
  id: string;
  email: string | null;
  phone: string | null;
}

export interface OutreachAttemptRow {
  subscriber_id: string;
  client_id: string;
  invoice_id: string; // LOCAL uuid (see NON-NEGOTIABLE above)
  channel: "email" | "sms";
  status: "sent";
  sent_at: string; // ISO 8601
  attempt_number: 1;
  counted_toward_limit: false;
  notes: string;
  communication_id: null;
}

/**
 * Permissibility seam — STUB. Real allowed-contact-window / timezone / quiet-hours
 * / do-not-contact rules are deferred to a later brick. Returns true for now. The
 * engine MUST call this, so the seam cannot be removed without breaking the build.
 */
export function isContactAllowed(_client: EligClient, _now: Date): boolean {
  return true;
}

// Past-due = a parseable due_date strictly before `now`. Null/unparseable → false
// (fail closed: a missing due date cannot establish past-due). Mirrors the date
// comparison the codebase already uses (lib/qbo/captureAdapter.ts resolveInvoicePastDue:
// `new Date(dueDate) < new Date(reference)`; lib/adapters.ts uses `new Date()` for today).
function isPastDue(dueDate: string | null, now: Date): boolean {
  if (dueDate == null) return false;
  const d = new Date(dueDate);
  if (isNaN(d.getTime())) return false;
  return d.getTime() < now.getTime();
}

// Channel availability + v1 selection: email default when present, else sms when
// only phone. null = no channel → not contactable → not eligible.
function pickChannel(client: EligClient): "email" | "sms" | null {
  if (client.email) return "email";
  if (client.phone) return "sms";
  return null;
}

export function evaluateOutreachEligibility(
  invoices: EligInvoice[],
  clients: EligClient[],
  existingAttemptInvoiceIds: ReadonlySet<string>,
  now: Date,
): OutreachAttemptRow[] {
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const sentAt = now.toISOString();
  const rows: OutreachAttemptRow[] = [];

  for (const inv of invoices) {
    // Idempotency v1: one recovery_attempts row per invoice, ever.
    if (existingAttemptInvoiceIds.has(inv.id)) continue;
    // Past-due (null due_date → NOT eligible, fail closed).
    if (!isPastDue(inv.due_date, now)) continue;
    // Channel availability.
    const client = clientById.get(inv.client_id);
    if (!client) continue;
    const channel = pickChannel(client);
    if (channel === null) continue;
    // Permissibility seam (stub → always true today).
    if (!isContactAllowed(client, now)) continue;

    rows.push({
      subscriber_id: inv.subscriber_id,
      client_id: inv.client_id,
      invoice_id: inv.id, // LOCAL uuid — non-negotiable
      channel,
      status: "sent",
      sent_at: sentAt,
      attempt_number: 1,
      counted_toward_limit: false,
      notes: SIMULATION_NOTE,
      communication_id: null,
    });
  }

  return rows;
}

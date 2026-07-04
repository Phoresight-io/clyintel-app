import { getSupabase } from "../supabase";
import { createLiveCaptureDeps } from "../capture/captureDepsLive";
import { processCaptureEvent } from "../capture/processCaptureEvent";
import { resolveInvoicePastDue } from "../qbo/captureAdapter";
import type { CaptureEvent } from "../capture/captureEvent";

// Recovery-checkout capture bridge (PR 2b). Runs on Stripe
// `checkout.session.completed`. It maps a completed recovery Checkout Session
// back to its recovery_links row, flips the link to 'paid', records the
// settlement, then hands a CaptureEvent to the SAME frozen detection core + live
// deps the QBO worker uses. The frozen core is imported only — never modified.
//
// Relative imports (not the @/ alias) so vitest — which runs without the alias —
// can mock the seam, matching the lib/qbo/worker.ts testing convention.
//
// Split of responsibility:
//   - The LINK flip ('paid' + settlement) always happens once we match a row:
//     the payment happened, so the link IS paid even if rev-share is later gated
//     out by the engine.
//   - The LEDGER write (and invoice_number enrichment) is the engine + deps' job
//     — never done here. A gated rejection (e.g. outreachSent === false) is a
//     VALID outcome; we log it and return normally.

const RECOVERY_SOURCE = "stripe_recovery"; // registry slug (seeded in PR 2a)
const QBO_PROVIDER = "quickbooks"; // connected_accounts.provider for the realm lookup

interface RecoveryLinkRow {
  id: string;
  invoice_id: string;
  subscriber_id: string;
  link_status: string;
}

// Resolve the recovery_links row for a completed session. Primary match is the
// session id persisted in PR 1; token metadata is the fallback (PR 1's writeback
// was non-fatal, so stripe_checkout_session_id can be null). Returns null when
// the session belongs to no recovery link (a subscription/other session).
async function resolveLink(
  supabase: ReturnType<typeof getSupabase>,
  sessionId: string | null,
  token: string | null,
): Promise<RecoveryLinkRow | null> {
  const cols = "id, invoice_id, subscriber_id, link_status";

  if (sessionId) {
    const { data } = await supabase
      .from("recovery_links")
      .select(cols)
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();
    if (data) return data as RecoveryLinkRow;
  }
  if (token) {
    const { data } = await supabase
      .from("recovery_links")
      .select(cols)
      .eq("token", token)
      .maybeSingle();
    if (data) return data as RecoveryLinkRow;
  }
  return null;
}

// `session` is the Stripe checkout.session.completed event's data.object.
// `eventCreated` is the event's unix-seconds timestamp (drives capturedAt).
export async function handleRecoveryCheckoutCompleted(
  session: Record<string, unknown>,
  eventId: string,
  eventCreated: number | undefined,
): Promise<void> {
  const supabase = getSupabase();

  // Exact Stripe field paths on the completed session object:
  const sessionId = typeof session["id"] === "string" ? (session["id"] as string) : null;
  const amountTotal =
    typeof session["amount_total"] === "number" ? (session["amount_total"] as number) : null;
  const paymentIntent =
    typeof session["payment_intent"] === "string" ? (session["payment_intent"] as string) : null;
  const metadata = (session["metadata"] as Record<string, unknown> | undefined) ?? {};
  const token =
    typeof metadata["recovery_link_token"] === "string"
      ? (metadata["recovery_link_token"] as string)
      : null;

  // ── a. Resolve the recovery_links row (session id → token fallback). ─────────
  const link = await resolveLink(supabase, sessionId, token);
  if (!link) {
    // Not a recovery session (subscription/other) — acknowledge and ignore.
    return;
  }

  // ── b. Idempotency FIRST. Already paid → stop: no reprocess, no 2nd capture. ─
  if (link.link_status === "paid") {
    console.log(
      `stripe-webhook: recovery link ${link.id} already paid (event=${eventId}); skipping`,
    );
    return;
  }

  // ── c. Flip to paid + record settlement. Persists regardless of the capture
  //       outcome below — the payment happened, so the link IS paid. ───────────
  const { error: flipError } = await supabase
    .from("recovery_links")
    .update({
      link_status: "paid",
      settlement_amount_cents: amountTotal,
      updated_at: new Date().toISOString(),
    })
    .eq("id", link.id);
  if (flipError) {
    // We could not even record the payment — do not attempt capture. Stripe will
    // redeliver; the idempotency guard is armed only after a successful flip.
    console.error(
      `stripe-webhook: failed to flip recovery link ${link.id} to paid (event=${eventId})`,
      flipError,
    );
    return;
  }

  // ── d. Build the CaptureEvent. ──────────────────────────────────────────────
  // payment_intent is the ledger idempotency grain (source, source_payment_id).
  // Absent in Checkout 'payment' mode is anomalous → log-and-bail; never switch
  // grain silently to the session id.
  if (!paymentIntent) {
    console.error(
      `stripe-webhook: recovery session ${sessionId} has no payment_intent (event=${eventId}); ` +
        `link flipped to paid, capture skipped`,
    );
    return;
  }

  const { data: invoice, error: invError } = await supabase
    .from("invoices")
    .select("external_id, amount_cents, due_date")
    .eq("id", link.invoice_id)
    .maybeSingle();
  if (invError || !invoice) {
    console.error(
      `stripe-webhook: recovery link ${link.id} invoice ${link.invoice_id} not found ` +
        `(event=${eventId}); capture skipped`,
      invError,
    );
    return;
  }
  if (!invoice.external_id) {
    console.error(
      `stripe-webhook: recovery link ${link.id} invoice ${link.invoice_id} has no external_id ` +
        `(not QBO-sourced?); capture skipped (event=${eventId})`,
    );
    return;
  }

  // connectedAccountRef = the invoice's QBO realm id, reached through the
  // subscriber's QuickBooks connection. No (subscriber_id, provider) uniqueness
  // constraint exists, so 0 or >1 connections is ambiguous — do NOT guess the
  // realm; skip the capture (link is already paid) and log subscriber + count.
  const { data: conns, error: connError } = await supabase
    .from("connected_accounts")
    .select("external_id")
    .eq("provider", QBO_PROVIDER)
    .eq("subscriber_id", link.subscriber_id);
  if (connError) {
    console.error(
      `stripe-webhook: connected_accounts lookup failed for subscriber ${link.subscriber_id} ` +
        `(event=${eventId}); link flipped to paid, capture skipped`,
      connError,
    );
    return;
  }
  const realmCount = conns?.length ?? 0;
  if (realmCount !== 1 || !conns![0].external_id) {
    console.error(
      `stripe-webhook: cannot resolve unique QBO realm for subscriber ${link.subscriber_id} — ` +
        `found ${realmCount} quickbooks connection(s) (event=${eventId}); ` +
        `link flipped to paid, capture skipped`,
    );
    return;
  }
  const realmId = conns![0].external_id;

  // One timestamp serves BOTH capturedAt and the past-due reference date,
  // mirroring the QBO path's use of the payment TxnDate. invoicePastDue is
  // resolved via the adapter's exported rule (never date-math'd here); dueDate is
  // the synced local invoices.due_date (equal to the live QBO DueDate by
  // construction — the QBO sync copies it).
  const capturedAt = new Date(
    (eventCreated ?? Math.floor(Date.now() / 1000)) * 1000,
  ).toISOString();

  const event: CaptureEvent = {
    source: RECOVERY_SOURCE,
    sourcePaymentId: paymentIntent,
    sourceInvoiceId: invoice.external_id,
    invoicePastDue: resolveInvoicePastDue(invoice.due_date, capturedAt),
    invoiceFaceValue: invoice.amount_cents / 100,
    dollarsRecovered: (amountTotal ?? 0) / 100,
    capturedAt,
    connectedAccountRef: realmId,
  };

  // ── e. Run the SAME core + live deps as the QBO worker. A gated rejection is a
  //       valid outcome — never throw on it; log the CaptureResult and return. A
  //       thrown error is an infra fault (DB/lookup); the link is already paid,
  //       so log and swallow rather than bubbling into waitUntil. ──────────────
  try {
    const deps = createLiveCaptureDeps();
    const result = await processCaptureEvent(event, deps);
    console.log(
      `stripe-webhook: recovery capture for link ${link.id} (event=${eventId}) → ${JSON.stringify(result)}`,
    );
  } catch (err) {
    console.error(
      `stripe-webhook: recovery capture threw for link ${link.id} (event=${eventId})`,
      err,
    );
  }
}

/**
 * Detection core — pure orchestration over injected deps. Decides whether a
 * captured payment earns rev share and, if so, freezes an idempotent ledger row.
 *
 * It NEVER computes a fee, rate, band, or past-due verdict itself:
 *  - fees/bands/rates come solely from computeRevShareFee (the engine).
 *  - past-due comes solely from event.invoicePastDue (adapter-resolved).
 * It never throws on a business rejection — every outcome is a CaptureResult.
 */

import { computeRevShareFee, ENGINE_VERSION } from '../revshare/computeRevShareFee';
import { nextCycleCloseDate } from '../revshare/accrualLedger';
import { CaptureEvent } from './captureEvent';
import { CaptureDeps } from './captureDeps';
import { CaptureResult } from './captureResult';

export async function processCaptureEvent(
  event: CaptureEvent,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  // 1. VALIDATE SOURCE
  const src = await deps.getSource(event.source);
  if (src == null) {
    return { status: 'rejected', reason: 'unknown_source' };
  }
  if (src.active === false) {
    return { status: 'rejected', reason: 'inactive_source' };
  }

  // 2. RESOLVE SUBSCRIBER
  const r = await deps.resolveSubscriber(event.connectedAccountRef);
  if (!r.ok) {
    return { status: 'rejected', reason: r.reason };
  }
  const subscriberId = r.subscriberId;

  // 3. ATTRIBUTION GATE — three trusted booleans, no calculation.
  if (event.invoicePastDue !== true) {
    return { status: 'no_fee', reason: 'not_past_due' };
  }
  const attribution = await deps.getInvoiceAttribution(subscriberId, event.sourceInvoiceId);
  if (attribution.outreachSent !== true) {
    return { status: 'no_fee', reason: 'no_outreach' };
  }
  if ((await deps.isSubscriberActive(subscriberId)) !== true) {
    return { status: 'no_fee', reason: 'subscriber_inactive' };
  }

  // 4. FREEZE + COMPUTE — the engine is the only fee source.
  const fee = computeRevShareFee({
    invoiceFaceValue: event.invoiceFaceValue,
    dollarsRecovered: event.dollarsRecovered,
  });
  // Non-qualifying (engine below its own floor) — do NOT re-check the floor here.
  // band === null only ever co-occurs with !qualifies; the check also narrows the type.
  if (!fee.qualifies || fee.band === null) {
    return { status: 'no_fee', reason: 'below_minimum' };
  }
  const { band, rate, feeAmount } = fee;

  // 5. IDEMPOTENT WRITE
  const cycleClose = nextCycleCloseDate(new Date(event.capturedAt));
  const res = await deps.insertLedgerRow({
    subscriber_id: subscriberId,
    source: event.source,
    source_payment_id: event.sourcePaymentId,
    source_invoice_id: event.sourceInvoiceId,
    invoice_ref: event.sourceInvoiceId,
    invoice_face_value: event.invoiceFaceValue,
    dollars_recovered: event.dollarsRecovered,
    band,
    rate,
    fee_amount: feeAmount,
    captured_at: event.capturedAt,
    cycle_close: cycleClose.toISOString().slice(0, 10),
    engine_version: ENGINE_VERSION,
  });

  if (res.inserted) {
    return { status: 'written', ledgerId: res.id, feeAmount, band, rate };
  }
  return { status: 'duplicate', ledgerId: res.existingId };
}

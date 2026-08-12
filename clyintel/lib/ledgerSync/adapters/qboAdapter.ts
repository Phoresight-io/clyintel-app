import { getValidAccessToken } from "../../qbo/tokens";
import { getInvoice } from "../../qbo/client";
import { qboPostEntity } from "../../qbo/writeClient";
import { getSupabase } from "../../supabase";

// QuickBooks ledger-sync adapter — D2 Phase 1 (real Payment POST + idempotency).
//
// Reflects a captured recovery payment into QBO by writing a Payment that marks
// the external invoice Paid in Full. Idempotency + retry accounting live in the
// `ledger_sync` table (composite unique on (source_payment_id, provider)); this
// adapter is the guard + the write, NOT the retry driver (that is external —
// Stripe replay / a future worker).
//
// Guard order (before any POST):
//   1. Upsert the ledger_sync row on (source_payment_id, provider).
//   2. status='done'  → short-circuit, return the existing external_payment_id.
//   3. status='dead'  → terminal skip.
//   4. attempts >= max_attempts → flip to 'dead', skip. (This is the cap.)
//   5. else attempt: increment attempts, POST the Payment, then 'done' on
//      success / 'failed' (or 'dead' at the cap) on failure.
//
// Never throws past the seam — every outcome is a typed QboReflectResult. The
// token is obtained via getValidAccessToken (refresh/rotation handled there); the
// POST goes through the additive qboPostEntity primitive. The frozen GET client
// (getInvoice) is used read-only to resolve the required CustomerRef.
//
// Relative imports (not the @/ alias) match the capture/money-path convention so
// vitest — which runs without the alias — can mock the qbo + supabase seams.

const PROVIDER = "quickbooks" as const;

/**
 * Provider-neutral input contract (LOCKED). The neutral seam passes this exact
 * shape to whichever adapter matches `provider`.
 */
export interface ReflectPaymentInput {
  subscriberId: string;
  provider: string;
  externalInvoiceId: string;
  amountPaidCents: number;
  currency: string;
  capturePaymentId: string;
  ledgerRowId: string;
}

/** Typed result of the QBO adapter. Never thrown — always returned. */
export type QboReflectResult =
  | {
      ok: true;
      provider: "quickbooks";
      status: "done";
      externalPaymentId: string | null;
      alreadyReflected: boolean;
    }
  | { ok: false; skipped: true; reason: "dead" }
  | { ok: false; error: string };

/** Minimal shapes we read off the QBO responses (escape-hatch typed). */
interface QboPaymentCreated {
  Id: string;
  raw?: unknown;
}
interface QboInvoiceRaw {
  CustomerRef?: { value?: string };
}

export async function qboReflectPayment(
  input: ReflectPaymentInput,
): Promise<QboReflectResult> {
  const service = getSupabase();

  // 1. Ensure a ledger_sync row exists for this (source_payment_id, provider).
  //    ignoreDuplicates: a concurrent/replayed call keeps the existing row's
  //    status + attempts rather than resetting them.
  const { error: upsertErr } = await service.from("ledger_sync").upsert(
    {
      ledger_row_id: input.ledgerRowId,
      source_payment_id: input.capturePaymentId,
      provider: PROVIDER,
      status: "pending",
    },
    { onConflict: "source_payment_id,provider", ignoreDuplicates: true },
  );
  if (upsertErr) {
    return { ok: false, error: `ledger_sync upsert failed: ${upsertErr.message}` };
  }

  // Read the authoritative current row.
  const { data: row, error: readErr } = await service
    .from("ledger_sync")
    .select("id, status, attempts, max_attempts, external_payment_id")
    .eq("source_payment_id", input.capturePaymentId)
    .eq("provider", PROVIDER)
    .single();
  if (readErr || !row) {
    return { ok: false, error: `ledger_sync read failed: ${readErr?.message ?? "no row"}` };
  }

  // 2. Already reflected → short-circuit (carry the existing QBO Payment Id).
  if (row.status === "done") {
    return {
      ok: true,
      provider: PROVIDER,
      status: "done",
      externalPaymentId: row.external_payment_id,
      alreadyReflected: true,
    };
  }
  // 3. Terminal.
  if (row.status === "dead") {
    return { ok: false, skipped: true, reason: "dead" };
  }
  // 4. Cap reached (a prior 'failed'/'pending' row that exhausted attempts) →
  //    flip to dead and skip. Bounded here, never an in-line retry loop.
  if (row.attempts >= row.max_attempts) {
    await service
      .from("ledger_sync")
      .update({ status: "dead", updated_at: new Date().toISOString() })
      .eq("id", row.id);
    return { ok: false, skipped: true, reason: "dead" };
  }

  // 5. Attempt. Increment attempts up front so a crash still counts the try.
  const attemptNo = row.attempts + 1;
  await service
    .from("ledger_sync")
    .update({ attempts: attemptNo, updated_at: new Date().toISOString() })
    .eq("id", row.id);

  try {
    const { accessToken, realmId } = await getValidAccessToken(input.subscriberId);

    // CustomerRef is required on a QBO Payment create. Resolve it from the live
    // invoice (also proves the invoice is reachable). getInvoice throws non-2xx.
    const invoice = await getInvoice(realmId, input.externalInvoiceId, accessToken);
    const customerId = (invoice.raw as QboInvoiceRaw | undefined)?.CustomerRef?.value;
    if (!customerId) {
      throw new Error(
        `QBO invoice ${input.externalInvoiceId} has no CustomerRef.value; cannot build Payment`,
      );
    }

    // Full face value was paid through the recovery link → mark Paid in Full.
    // (Settlement/partial reflect is out of Phase 1 scope.)
    const amount = input.amountPaidCents / 100;
    const body = {
      CustomerRef: { value: customerId },
      TotalAmt: amount,
      TxnDate: new Date().toISOString().slice(0, 10),
      PrivateNote: `Clyintel recovery reflect (${input.capturePaymentId})`,
      Line: [
        {
          Amount: amount,
          LinkedTxn: [{ TxnId: input.externalInvoiceId, TxnType: "Invoice" }],
        },
      ],
    };

    const payment = await qboPostEntity<QboPaymentCreated>(
      realmId,
      "payment",
      accessToken,
      body,
    );
    const externalPaymentId = payment.Id;

    await service
      .from("ledger_sync")
      .update({
        status: "done",
        external_payment_id: externalPaymentId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    return {
      ok: true,
      provider: PROVIDER,
      status: "done",
      externalPaymentId,
      alreadyReflected: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // At the cap after this failed attempt → terminal; otherwise retryable.
    const nowDead = attemptNo >= row.max_attempts;
    await service
      .from("ledger_sync")
      .update({
        status: nowDead ? "dead" : "failed",
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { ok: false, error: message };
  }
}

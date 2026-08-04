import { getValidAccessToken } from "../../qbo/tokens";
import { getInvoice } from "../../qbo/client";

// QuickBooks ledger-sync adapter — Phase 0 PROVING STUB (D2, §3 deliverable #3).
//
// Purpose: prove the rails BEFORE anything touches a customer's books. It
// authenticates (which exercises getValidAccessToken's proactive refresh +
// Intuit refresh-token rotation) and does a single READ-ONLY round-trip against
// sandbox QBO. It writes NOTHING.
//
// Explicitly NOT in Phase 0: no Payment POST, no qboPostEntity / writeClient
// call (writeClient is on main but intentionally NOT imported here — the real
// write is Phase 1), no fee logic, no idempotency, no wiring into the money path
// (handleCheckoutCompleted). Phase 1 replaces the stub body with the real write.
//
// Error policy: this stub does NOT catch. getValidAccessToken and getInvoice
// throw on failure (e.g. a 401 with an auth-flavored message), and those errors
// PROPAGATE. The neutral seam (deliverable #4, lib/ledgerSync/reflectPayment.ts)
// is the layer that catches and types errors — not the adapter.
//
// Relative imports (not the @/ alias) match the capture/money-path convention
// (see handleCheckoutCompleted.ts) so vitest — which runs without the alias —
// can mock the qbo seam.

/**
 * Provider-neutral input contract (LOCKED). The neutral seam passes this exact
 * shape to whichever adapter matches `provider`; nothing provider-specific
 * leaks up to the webhook.
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

/** Phase 0 stub result: read-only rails proven, zero writes to books. */
export interface QboReflectProbeResult {
  ok: true;
  provider: "quickbooks";
  probe: "read-verified";
}

/**
 * Phase 0 proving stub. Authenticates for the subscriber and performs a
 * read-only GET of the external invoice to prove the token + realm reach QBO.
 * No write. Any failure propagates to the caller (the seam types it).
 */
export async function qboReflectPayment(
  input: ReflectPaymentInput,
): Promise<QboReflectProbeResult> {
  // Proves refresh + scope: resolves (and, if near expiry, refreshes) the token
  // and the realm from the subscriber's connected_accounts row.
  const { accessToken, realmId } = await getValidAccessToken(input.subscriberId);

  // Read-only round-trip: proves the token + realm actually reach sandbox QBO.
  // Throws on non-2xx (auth-flavored on 401) — deliberately not caught here.
  await getInvoice(realmId, input.externalInvoiceId, accessToken);

  return { ok: true, provider: "quickbooks", probe: "read-verified" };
}

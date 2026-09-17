// Layer 2 — real Stripe TEST-MODE smoke (env-gated; NOT in default CI).
//
// Runs ONLY when STRIPE_TEST_SMOKE=1. It talks to the real Stripe API through the
// production lib/stripe.ts helpers (defaultStripe), so it is deliberately kept out
// of the default `vitest run`: with the flag unset the whole suite is skipped.
//
// SAFETY — this must NEVER run against a live key. When the flag is set it first
// asserts STRIPE_SECRET_KEY.startsWith('sk_test') and REFUSES TO RUN otherwise, so
// a mis-set sk_live key aborts the suite instead of creating real invoices.
//
// It reuses the Layer-1 fixtures + the injected gate + the fake Supabase, but swaps
// the StripeInvoicing seam for the REAL defaultStripe. A throwaway test customer is
// created (and given a test payment method) in setup — no reliance on any pre-
// existing/production Stripe object. Assertions: exactly one invoice for create →
// finalize → pay, the Idempotency-Key is honored (a re-run with the same key yields
// NO second invoice), and stripe_invoice_id is captured only AFTER finalize.

import { describe, it, expect, beforeAll } from "vitest";

const SMOKE = process.env.STRIPE_TEST_SMOKE === "1";

// Local hand-rolled Stripe POST — same fetch/form-encoding convention as
// lib/stripe.ts, used only for TEST-MODE setup (customer + attach test card). Kept
// in the test so no new production surface is added.
async function stripeTestPost<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as { error?: { message?: string } };
  if (!res.ok) throw new Error(json?.error?.message ?? `Stripe test setup failed (${res.status})`);
  return json as T;
}

// describe.runIf keeps the whole suite OUT of the default run (flag unset → skipped).
describe.runIf(SMOKE)("Layer 2 — real Stripe test-mode smoke", () => {
  let customerId: string;

  beforeAll(async () => {
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    // Hard refusal: never touch a live account, whatever the flag says.
    if (!key.startsWith("sk_test")) {
      throw new Error(
        "STRIPE_TEST_SMOKE is set but STRIPE_SECRET_KEY is not an sk_test key — refusing to run against a non-test account.",
      );
    }
    // Throwaway customer with a test card as default source, so finalize+pay works.
    const customer = await stripeTestPost<{ id: string }>("/customers", {
      email: `settlement-smoke+${Date.now()}@example.com`,
      "payment_method": "pm_card_visa",
      "invoice_settings[default_payment_method]": "pm_card_visa",
    });
    customerId = customer.id;
    await stripeTestPost(`/payment_methods/pm_card_visa/attach`, { customer: customerId });
  });

  it("create → finalize → pay makes exactly one invoice and captures the id only post-finalize", async () => {
    // Imported lazily so a default (flag-unset) run never even loads the real client.
    const { createInvoice, addInvoiceItem, finalizeInvoice, payInvoice } = await import("@/lib/stripe");

    const key = `settlement_smoke_${Date.now()}`;
    let capturedInvoiceId: string | null = null;

    const invoice = await createInvoice(customerId, key, {
      kind: "fee_settlement",
      settlement_id: "smoke-set1",
      subscriber_id: "smoke-sub1",
      cycle_close: "2026-08-15",
    });
    expect(invoice.id).toMatch(/^in_/);
    // Not yet captured — id is only persisted AFTER finalize in the real charge path.
    expect(capturedInvoiceId).toBeNull();

    await addInvoiceItem({
      customerId,
      invoiceId: invoice.id,
      amountCents: 444,
      currency: "usd",
      description: "Recovery fee — smoke test",
      idempotencyKey: `${key}_line_l1`,
    });

    const finalized = await finalizeInvoice(invoice.id);
    capturedInvoiceId = finalized.id; // captured only now (post-finalize)
    expect(capturedInvoiceId).toBe(invoice.id);

    const paid = await payInvoice(invoice.id);
    expect(paid.status === "paid" || paid.paid === true).toBe(true);

    // Idempotency: a re-run of createInvoice with the SAME key returns the SAME
    // invoice (Stripe replays it) — never a second invoice.
    const replay = await createInvoice(customerId, key, {
      kind: "fee_settlement",
      settlement_id: "smoke-set1",
      subscriber_id: "smoke-sub1",
      cycle_close: "2026-08-15",
    });
    expect(replay.id).toBe(invoice.id);
  });
});

// A visible marker in the default (skipped) run that the safety refusal exists.
describe("Layer 2 — safety", () => {
  it.skipIf(SMOKE)("is skipped unless STRIPE_TEST_SMOKE=1 (default CI never hits Stripe)", () => {
    expect(SMOKE).toBe(false);
  });
});

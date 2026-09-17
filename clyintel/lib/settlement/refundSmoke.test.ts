// Layer 2 — real Stripe TEST-MODE smoke for refund/void (env-gated; NOT in CI).
//
// Runs ONLY when STRIPE_TEST_SMOKE=1. It exercises the production refund/void
// helpers (lib/stripe.ts) against the real Stripe API, so it is kept out of the
// default `vitest run`: with the flag unset the whole suite is skipped.
//
// SAFETY — never against a live key. When the flag is set it first asserts
// STRIPE_SECRET_KEY.startsWith('sk_test') and REFUSES TO RUN otherwise, so a
// mis-set sk_live key aborts instead of moving real money.
//
// Asserts: a real test-mode paid charge is refunded via refundCharge (refund id
// captured, Idempotency-Key echoed → a re-run with the same key returns the SAME
// refund, no second refund); a real finalized-but-unpaid invoice is voided via
// voidInvoice. Uses throwaway test-mode objects created in setup — no reliance on
// any pre-existing/production Stripe object.

import { describe, it, expect, beforeAll } from "vitest";

const SMOKE = process.env.STRIPE_TEST_SMOKE === "1";

// Local hand-rolled Stripe POST — same fetch/form-encoding convention as
// lib/stripe.ts, used only for TEST-MODE setup (charge, customer, invoice item).
async function stripeTestPost<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as { error?: { message?: string } };
  if (!res.ok) throw new Error(json?.error?.message ?? `Stripe test setup failed (${res.status})`);
  return json as T;
}

describe.runIf(SMOKE)("Layer 2 — real Stripe test-mode refund/void smoke", () => {
  beforeAll(() => {
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    if (!key.startsWith("sk_test")) {
      throw new Error(
        "STRIPE_TEST_SMOKE is set but STRIPE_SECRET_KEY is not an sk_test key — refusing to run against a non-test account.",
      );
    }
  });

  it("refundCharge: refunds a real paid charge; same Idempotency-Key returns the SAME refund", async () => {
    const { refundCharge } = await import("@/lib/stripe");

    // A real succeeded test-mode charge (tok_visa is Stripe's test card token).
    const charge = await stripeTestPost<{ id: string }>("/charges", {
      amount: "500",
      currency: "usd",
      source: "tok_visa",
      description: "settlement refund smoke",
    });
    expect(charge.id).toMatch(/^ch_/);

    const key = `refund_smoke_${Date.now()}`;
    const refund = await refundCharge({ charge: charge.id }, { amountCents: 500, idempotencyKey: key });
    expect(refund.id).toMatch(/^re_/);
    expect(["succeeded", "pending"]).toContain(refund.status);

    // Idempotency: same key → the SAME refund, never a second one.
    const replay = await refundCharge({ charge: charge.id }, { amountCents: 500, idempotencyKey: key });
    expect(replay.id).toBe(refund.id);
  });

  it("voidInvoice: voids a real finalized-but-unpaid invoice", async () => {
    const { finalizeInvoice, voidInvoice } = await import("@/lib/stripe");

    const customer = await stripeTestPost<{ id: string }>("/customers", {
      email: `refund-smoke+${Date.now()}@example.com`,
    });
    await stripeTestPost("/invoiceitems", { customer: customer.id, amount: "700", currency: "usd" });
    // send_invoice (not charge_automatically) so finalize leaves it OPEN/unpaid.
    const draft = await stripeTestPost<{ id: string }>("/invoices", {
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: "30",
      auto_advance: "false",
    });
    await finalizeInvoice(draft.id);

    const voided = await voidInvoice(draft.id, { idempotencyKey: `void_smoke_${Date.now()}` });
    expect(voided.status).toBe("void");
  });
});

// Visible marker in the default (skipped) run that the safety refusal exists.
describe("Layer 2 — safety", () => {
  it.skipIf(SMOKE)("is skipped unless STRIPE_TEST_SMOKE=1 (default CI never hits Stripe)", () => {
    expect(SMOKE).toBe(false);
  });
});

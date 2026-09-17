// Layer 1 — deterministic refund-execution test (default CI, NO network).
//
// Drives refundSettlement through the shared in-memory fake Supabase and a fake
// StripeRefunding recorder, with the env/live gate INJECTED as () => true so the
// real refund/void branch runs against no production env. Everything in-memory:
// no network, no real DB/Stripe. See refundSmoke.test.ts for the env-gated
// real-test-mode smoke.

import { describe, it, expect } from "vitest";
import { refundSettlement, type StripeRefunding } from "./refundSettlement";
import { makeFakeSupabase, type Row } from "./testSupport/fakeSupabase";

// ── fake Stripe recorder ──────────────────────────────────────────────────────
function makeStripe(over: Partial<StripeRefunding> = {}) {
  const calls = {
    retrieveInvoice: [] as string[],
    refundCharge: [] as { target: { paymentIntent?: string | null; charge?: string | null }; args: { amountCents: number; idempotencyKey: string } }[],
    voidInvoice: [] as { id: string; args: { idempotencyKey: string } }[],
  };
  const stripe: StripeRefunding = {
    retrieveInvoice: async (id) => {
      calls.retrieveInvoice.push(id);
      return { id, status: "paid", payment_intent: "pi_1", charge: "ch_1" };
    },
    refundCharge: async (target, args) => {
      calls.refundCharge.push({ target, args });
      return { id: "re_1", status: "succeeded" };
    },
    voidInvoice: async (id, args) => {
      calls.voidInvoice.push({ id, args });
      return { id, status: "void" };
    },
    ...over,
  };
  return { stripe, calls };
}
const neverStripe: StripeRefunding = {
  retrieveInvoice: async () => { throw new Error("Stripe must not be called"); },
  refundCharge: async () => { throw new Error("Stripe must not be called"); },
  voidInvoice: async () => { throw new Error("Stripe must not be called"); },
};

// ── fixtures ──────────────────────────────────────────────────────────────────
const settlementSeed = (over: Record<string, unknown> = {}): Row => ({
  id: "set1",
  subscriber_id: "subA",
  status: "paid",
  total_fee_cents: 444,
  stripe_invoice_id: "in_1",
  currency: "USD",
  line_count: 2,
  attempts: 0,
  max_attempts: 5,
  claimed_at: null,
  ...over,
});
const subSeed = (over: Record<string, unknown> = {}): Row => ({
  id: "subA",
  subscription_status: "active",
  test_user: false,
  stripe_customer_id: "cus_1",
  ...over,
});

function setup(opts: {
  fee?: Record<string, unknown>;
  sub?: Record<string, unknown>;
  refundsEnabled?: boolean;
  refundRows?: Row[];
} = {}) {
  return makeFakeSupabase({
    settlements: [settlementSeed(opts.fee)],
    subscribers: [subSeed(opts.sub)],
    appConfig: opts.refundsEnabled === false ? {} : { settlement_refunds_enabled: true },
    refunds: opts.refundRows ?? [],
  });
}

type Svc = NonNullable<Parameters<typeof refundSettlement>[1]["supabase"]>;
const svc = (fake: ReturnType<typeof setup>) => fake.client as unknown as Svc;
// The four-part gate with env/live injected on; caller still supplies reason/actor.
const base = (fake: ReturnType<typeof setup>, stripe: StripeRefunding) => ({
  reason: "customer_goodwill",
  actor: "ops:charles",
  dryRun: false as const,
  liveChargesAllowed: () => true,
  stripe,
  supabase: svc(fake),
});

// ── REFUND path (paid) ─────────────────────────────────────────────────────────
describe("Layer 1 — refund path (paid settlement)", () => {
  it("refund succeeded → settlement 'refunded', row 'succeeded' kind='refund', key refund_{id}, id captured", async () => {
    const fake = setup();
    const { stripe, calls } = makeStripe();

    const out = await refundSettlement("set1", base(fake, stripe));

    expect(out).toMatchObject({ ok: true, action: "refunded", mechanism: "refund", stripeRefundId: "re_1" });
    expect(calls.refundCharge).toHaveLength(1);
    expect(calls.refundCharge[0].args.idempotencyKey).toBe("refund_set1");
    expect(calls.refundCharge[0].args.amountCents).toBe(444);
    expect(calls.refundCharge[0].target).toEqual({ paymentIntent: "pi_1", charge: "ch_1" });
    expect(fake.feeRows.get("set1")!.status).toBe("refunded");
    expect(fake.refundRows).toHaveLength(1);
    const row = fake.refundRows[0];
    expect(row).toMatchObject({ kind: "refund", amount_cents: 444, status: "succeeded", stripe_refund_id: "re_1", stripe_idempotency_key: "refund_set1", reason: "customer_goodwill", actor: "ops:charles" });
    // the settlement transitioned paid → refund_pending (claim) → refunded
    const feeStatuses = fake.writes.filter((w) => w.table === "fee_settlements").map((w) => (w.payload as Row).status);
    expect(feeStatuses).toEqual(["refund_pending", "refunded"]);
  });

  it("refund pending → settlement 'refund_pending', row 'pending'; terminal 'refunded' NOT set (Prompt 4's job)", async () => {
    const fake = setup();
    const { stripe } = makeStripe({ refundCharge: async () => ({ id: "re_p", status: "pending" }) });

    const out = await refundSettlement("set1", base(fake, stripe));

    expect(out).toMatchObject({ ok: true, action: "refund_pending", stripeRefundId: "re_p" });
    expect(fake.feeRows.get("set1")!.status).toBe("refund_pending"); // NOT 'refunded'
    expect(fake.refundRows[0]).toMatchObject({ status: "pending", stripe_refund_id: "re_p" });
  });

  it("refund failed → row 'failed', settlement back to 'paid', clean error, no terminal transition", async () => {
    const fake = setup();
    const { stripe } = makeStripe({ refundCharge: async () => ({ id: "re_f", status: "failed" }) });

    const out = await refundSettlement("set1", base(fake, stripe));

    expect(out).toMatchObject({ ok: false, action: "failed", reason: "refund_failed" });
    expect(fake.feeRows.get("set1")!.status).toBe("paid"); // rolled back
    expect(fake.refundRows[0]).toMatchObject({ status: "failed" });
  });
});

// ── VOID path (invoiced) ───────────────────────────────────────────────────────
describe("Layer 1 — void path (invoiced settlement)", () => {
  it("invoiced → voidInvoice once, settlement 'void', row 'succeeded' kind='void', stripe_refund_id null", async () => {
    const fake = setup({ fee: { status: "invoiced" } });
    const { stripe, calls } = makeStripe();

    const out = await refundSettlement("set1", base(fake, stripe));

    expect(out).toMatchObject({ ok: true, action: "voided", mechanism: "void", stripeRefundId: null });
    expect(calls.voidInvoice).toHaveLength(1);
    expect(calls.voidInvoice[0]).toMatchObject({ id: "in_1", args: { idempotencyKey: "void_set1" } });
    expect(calls.refundCharge).toHaveLength(0);
    expect(fake.feeRows.get("set1")!.status).toBe("void");
    expect(fake.refundRows[0]).toMatchObject({ kind: "void", status: "succeeded", stripe_idempotency_key: "void_set1" });
    expect(fake.refundRows[0].stripe_refund_id ?? null).toBeNull();
  });
});

// ── not-reversible states ──────────────────────────────────────────────────────
describe("Layer 1 — nothing to reverse", () => {
  for (const status of ["pending", "charging", "failed"]) {
    it(`${status} settlement → rejected, ZERO Stripe calls, no write`, async () => {
      const fake = setup({ fee: { status } });
      const out = await refundSettlement("set1", base(fake, neverStripe));
      expect(out).toMatchObject({ ok: false, action: "rejected" });
      expect(fake.writes).toHaveLength(0);
      expect(fake.refundRows).toHaveLength(0);
    });
  }
});

// ── idempotency / guards ───────────────────────────────────────────────────────
describe("Layer 1 — idempotency & over-refund guard", () => {
  it("double full refund: second call while 'refunded' → noop, NO second Stripe call, no duplicate row", async () => {
    const fake = setup();
    const { stripe, calls } = makeStripe();

    const first = await refundSettlement("set1", base(fake, stripe));
    expect(first.action).toBe("refunded");

    const second = await refundSettlement("set1", base(fake, stripe));
    expect(second).toMatchObject({ ok: true, action: "noop", reason: "already_refunded" });
    expect(calls.refundCharge).toHaveLength(1); // no second refund
    expect(fake.refundRows).toHaveLength(1); // no duplicate row
  });

  it("over-refund guard: an existing succeeded refund summing to total → rejected, no Stripe call", async () => {
    const fake = setup({
      refundRows: [
        { id: "rr0", settlement_id: "set1", kind: "refund", amount_cents: 444, status: "succeeded", stripe_idempotency_key: "refund_set1" },
      ],
    });
    const out = await refundSettlement("set1", base(fake, neverStripe));
    expect(out).toMatchObject({ ok: false, action: "rejected", reason: "nothing_refundable" });
    expect(fake.refundRows).toHaveLength(1); // no new row
  });
});

// ── gates force dry-run ────────────────────────────────────────────────────────
describe("Layer 1 — gates force dry-run (no Stripe, no write, no status change)", () => {
  it("test_user → forced dry-run/skip", async () => {
    const fake = setup({ sub: { test_user: true } });
    const out = await refundSettlement("set1", base(fake, neverStripe));
    expect(out).toMatchObject({ ok: true, action: "dry_run", reason: "test_user" });
    expect(fake.writes).toHaveLength(0);
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
  });

  it("inactive subscriber → forced dry-run/skip", async () => {
    const fake = setup({ sub: { subscription_status: "canceled" } });
    const out = await refundSettlement("set1", base(fake, neverStripe));
    expect(out).toMatchObject({ ok: true, action: "dry_run", reason: "subscriber_inactive" });
    expect(fake.writes).toHaveLength(0);
  });

  it("injected liveChargesAllowed:()=>false → forced dry-run", async () => {
    const fake = setup();
    const out = await refundSettlement("set1", { ...base(fake, neverStripe), liveChargesAllowed: () => false });
    expect(out).toMatchObject({ ok: true, action: "dry_run", reason: "gated" });
    expect(fake.writes).toHaveLength(0);
  });

  it("refunds flag absent → forced dry-run (fail-closed)", async () => {
    const fake = setup({ refundsEnabled: false });
    const out = await refundSettlement("set1", base(fake, neverStripe));
    expect(out).toMatchObject({ ok: true, action: "dry_run", reason: "gated" });
    expect(fake.writes).toHaveLength(0);
  });

  it("default dryRun (true) → forced dry-run even with the flag on and gate injectable", async () => {
    const fake = setup();
    const out = await refundSettlement("set1", { reason: "x", actor: "ops", liveChargesAllowed: () => true, stripe: neverStripe, supabase: svc(fake) });
    expect(out).toMatchObject({ ok: true, action: "dry_run" });
    expect(fake.writes).toHaveLength(0);
  });
});

// ── resume ─────────────────────────────────────────────────────────────────────
describe("Layer 1 — resume in-flight refund", () => {
  it("refund_pending + existing pending row + same key → no duplicate row; re-drives with same key; settles from returned status", async () => {
    const fake = setup({
      fee: { status: "refund_pending", claimed_at: new Date().toISOString() },
      refundRows: [
        { id: "rr1", settlement_id: "set1", kind: "refund", amount_cents: 444, status: "pending", stripe_idempotency_key: "refund_set1" },
      ],
    });
    const { stripe, calls } = makeStripe();

    const out = await refundSettlement("set1", base(fake, stripe));

    expect(out).toMatchObject({ ok: true, action: "refunded", refundRowId: "rr1" });
    // no NEW row inserted; the existing pending row is reused and settled
    expect(fake.refundRows).toHaveLength(1);
    expect(fake.refundRows[0]).toMatchObject({ id: "rr1", status: "succeeded", stripe_refund_id: "re_1" });
    // exactly one refundCharge, carrying the SAME key (Stripe replays → no double refund)
    expect(calls.refundCharge).toHaveLength(1);
    expect(calls.refundCharge[0].args.idempotencyKey).toBe("refund_set1");
    expect(fake.feeRows.get("set1")!.status).toBe("refunded");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chargeOneSettlement,
  drainSettlements,
  liveChargesAllowed,
  lineDescription,
  type SettlementRow,
  type SubscriberRow,
  type ChargeLine,
  type StripeInvoicing,
} from "./chargeSettlement";

// ── fixtures ─────────────────────────────────────────────────────────────────
const settlement = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  id: "set1",
  subscriberId: "subA",
  cycleClose: "2026-08-15",
  totalFeeCents: 444,
  lineCount: 2,
  status: "pending",
  attempts: 0,
  maxAttempts: 5,
  stripeInvoiceId: null,
  stripeIdempotencyKey: "settle_subA_2026-08-15",
  ...over,
});

const subscriber = (over: Partial<SubscriberRow> = {}): SubscriberRow => ({
  id: "subA",
  subscriptionStatus: "active",
  testUser: false,
  stripeCustomerId: "cus_123",
  ...over,
});

const LINES: ChargeLine[] = [
  { ledgerRowId: "l1", feeCents: 333, invoiceRef: "145", invoiceNumber: "1038", dollarsRecovered: 3900, band: "band1", rate: 0.22 },
  { ledgerRowId: "l2", feeCents: 111, invoiceRef: "146", invoiceNumber: null, dollarsRecovered: 500, band: "band1", rate: 0.22 },
];

function makeStripe(over: Partial<StripeInvoicing> = {}) {
  const calls = {
    createInvoice: [] as { customerId: string; key: string }[],
    addInvoiceItem: [] as Parameters<StripeInvoicing["addInvoiceItem"]>[0][],
    finalizeInvoice: [] as string[],
    payInvoice: [] as string[],
  };
  const stripe: StripeInvoicing = {
    createInvoice: async (customerId, key) => {
      calls.createInvoice.push({ customerId, key });
      return { id: "in_test1" };
    },
    addInvoiceItem: async (a) => {
      calls.addInvoiceItem.push(a);
      return { id: `ii_${a.idempotencyKey}` };
    },
    finalizeInvoice: async (id) => {
      calls.finalizeInvoice.push(id);
      return { id, status: "open" };
    },
    payInvoice: async (id) => {
      calls.payInvoice.push(id);
      return { id, status: "paid", paid: true };
    },
    ...over,
  };
  return { stripe, calls };
}

const neverCallStripe: StripeInvoicing = {
  createInvoice: async () => { throw new Error("Stripe must not be called"); },
  addInvoiceItem: async () => { throw new Error("Stripe must not be called"); },
  finalizeInvoice: async () => { throw new Error("Stripe must not be called"); },
  payInvoice: async () => { throw new Error("Stripe must not be called"); },
};

afterEach(() => vi.unstubAllEnvs());

// ── env/live gate ─────────────────────────────────────────────────────────────
describe("liveChargesAllowed", () => {
  it("true ONLY when VERCEL_ENV=production AND STRIPE_SECRET_KEY starts with sk_live", () => {
    expect(liveChargesAllowed({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_live_abc" })).toBe(true);
  });
  it("false for preview env even with a live key", () => {
    expect(liveChargesAllowed({ VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_live_abc" })).toBe(false);
  });
  it("false for a test key even in production", () => {
    expect(liveChargesAllowed({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(false);
  });
  it("false when unset", () => {
    expect(liveChargesAllowed({})).toBe(false);
  });
});

describe("lineDescription (transparency statement)", () => {
  it("names the recovered invoice, dollars recovered, rate and band", () => {
    expect(lineDescription(LINES[0])).toBe("Recovery fee — invoice #1038: 22% of $3900.00 recovered (band band1)");
  });
  it("falls back to invoice_ref when invoice_number is null", () => {
    expect(lineDescription(LINES[1])).toContain("invoice #146");
  });
});

// ── chargeOneSettlement ───────────────────────────────────────────────────────
describe("chargeOneSettlement — preconditions never charge", () => {
  it("test_user → skipped, no Stripe call", async () => {
    const out = await chargeOneSettlement(
      { settlement: settlement(), subscriber: subscriber({ testUser: true }), lines: LINES },
      neverCallStripe,
    );
    expect(out).toEqual({ action: "skipped", settlementId: "set1", reason: "test_user" });
  });

  it("inactive subscriber → skipped, no Stripe call", async () => {
    const out = await chargeOneSettlement(
      { settlement: settlement(), subscriber: subscriber({ subscriptionStatus: "canceled" }), lines: LINES },
      neverCallStripe,
    );
    expect(out.action).toBe("skipped");
  });

  it("missing stripe_customer_id → failed 'no_stripe_customer' (dunning), no Stripe call, attempts++", async () => {
    const out = await chargeOneSettlement(
      { settlement: settlement(), subscriber: subscriber({ stripeCustomerId: null }), lines: LINES },
      neverCallStripe,
    );
    expect(out).toEqual({
      action: "failed",
      settlementId: "set1",
      reason: "no_stripe_customer",
      update: { status: "failed", attempts: 1, last_error: "no_stripe_customer" },
    });
  });

  it("reconciliation mismatch → failed, NOT charged", async () => {
    const out = await chargeOneSettlement(
      { settlement: settlement({ totalFeeCents: 999 }), subscriber: subscriber(), lines: LINES }, // lines sum 444 != 999
      neverCallStripe,
    );
    expect(out.action).toBe("failed");
    if (out.action === "failed") expect(out.update.status).toBe("failed");
  });
});

describe("chargeOneSettlement — charge flow", () => {
  it("happy path: create → item per line (per-line idem keys) → finalize → pay → paid; cents match", async () => {
    const { stripe, calls } = makeStripe();
    const out = await chargeOneSettlement({ settlement: settlement(), subscriber: subscriber(), lines: LINES }, stripe);

    expect(out).toEqual({
      action: "charged",
      settlementId: "set1",
      update: { status: "paid", stripe_invoice_id: "in_test1", last_error: null },
    });
    // Invoice created with the stored idempotency key.
    expect(calls.createInvoice).toEqual([{ customerId: "cus_123", key: "settle_subA_2026-08-15" }]);
    // One item per line; amounts == fee_cents; per-line idempotency keys.
    expect(calls.addInvoiceItem.map((a) => a.amountCents)).toEqual([333, 111]);
    expect(calls.addInvoiceItem.map((a) => a.idempotencyKey)).toEqual([
      "settle_subA_2026-08-15_line_l1",
      "settle_subA_2026-08-15_line_l2",
    ]);
    // Invoice-item amounts reconcile to total_fee_cents exactly.
    expect(calls.addInvoiceItem.reduce((s, a) => s + a.amountCents, 0)).toBe(444);
    expect(calls.finalizeInvoice).toEqual(["in_test1"]);
    expect(calls.payInvoice).toEqual(["in_test1"]);
  });

  it("decline (payInvoice throws) → failed, attempts++, stripe_invoice_id retained for retry", async () => {
    const { stripe } = makeStripe({
      payInvoice: async () => { throw new Error("card_declined"); },
    });
    const out = await chargeOneSettlement({ settlement: settlement(), subscriber: subscriber(), lines: LINES }, stripe);
    expect(out.action).toBe("failed");
    if (out.action === "failed") {
      expect(out.update).toMatchObject({ status: "failed", stripe_invoice_id: "in_test1", attempts: 1 });
      expect(out.update.last_error).toMatch(/payment: card_declined/);
    }
  });

  it("resume: an already-finalized settlement (stripe_invoice_id set) skips create/finalize and only pays", async () => {
    const { stripe, calls } = makeStripe();
    const out = await chargeOneSettlement(
      { settlement: settlement({ stripeInvoiceId: "in_prev", status: "failed", attempts: 1 }), subscriber: subscriber(), lines: LINES },
      stripe,
    );
    expect(out.action).toBe("charged");
    expect(calls.createInvoice).toHaveLength(0);
    expect(calls.addInvoiceItem).toHaveLength(0);
    expect(calls.finalizeInvoice).toHaveLength(0);
    expect(calls.payInvoice).toEqual(["in_prev"]);
  });
});

// ── drainSettlements (DB-wired) ───────────────────────────────────────────────
type Result = { data: unknown; error: unknown };
function makeDb(tables: {
  app_config?: { value: unknown };
  fee_settlements?: unknown[];
  subscribers?: unknown[];
  fee_settlement_lines?: unknown[];
  rev_share_ledger?: unknown[];
}) {
  const updates: { id: unknown; payload: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = { _upd: false, _payload: undefined, _eqId: undefined };
    b.select = () => b;
    b.in = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { if (b._upd) b._eqId = val; return b; };
    b.update = (payload: Record<string, unknown>) => { b._upd = true; b._payload = payload; return b; };
    b.maybeSingle = () => b;
    b.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => {
      let res: Result;
      if (b._upd) {
        updates.push({ id: b._eqId, payload: b._payload as Record<string, unknown> });
        res = { data: null, error: null };
      } else if (table === "app_config") {
        res = { data: tables.app_config ?? null, error: null };
      } else {
        res = { data: (tables as Record<string, unknown[]>)[table] ?? [], error: null };
      }
      return Promise.resolve(res).then(onF, onR);
    };
    return b;
  };
  return { client: { from } as never, updates };
}

describe("drainSettlements — gates", () => {
  it("forced dry-run when the kill-switch is off (default dryRun): no Stripe, no DB writes", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    const { client, updates } = makeDb({
      app_config: { value: false }, // kill-switch OFF
      fee_settlements: [
        { id: "set1", subscriber_id: "subA", cycle_close: "2026-08-15", total_fee_cents: 444, line_count: 2, status: "pending", attempts: 0, max_attempts: 5, stripe_invoice_id: null, stripe_idempotency_key: "settle_subA_2026-08-15" },
      ],
      subscribers: [{ id: "subA", subscription_status: "active", test_user: false, stripe_customer_id: "cus_1" }],
      fee_settlement_lines: [
        { settlement_id: "set1", ledger_row_id: "l1", fee_cents: 333 },
        { settlement_id: "set1", ledger_row_id: "l2", fee_cents: 111 },
      ],
      rev_share_ledger: [
        { id: "l1", invoice_ref: "145", invoice_number: "1038", dollars_recovered: 3900, band: "band1", rate: 0.22 },
        { id: "l2", invoice_ref: "146", invoice_number: null, dollars_recovered: 500, band: "band1", rate: 0.22 },
      ],
    });

    const res = await drainSettlements({}, client, neverCallStripe); // dryRun defaults true
    expect(res.charging).toBe(false);
    expect(res.candidates).toBe(1);
    expect(res.charged).toBe(0);
    expect(updates).toHaveLength(0); // nothing written
    expect(res.outcomes[0]).toMatchObject({ action: "dry_run" });
  });

  it("does not select a dead-lettered settlement (failed with attempts == max_attempts)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    const { client } = makeDb({
      app_config: { value: true },
      fee_settlements: [
        { id: "dead", subscriber_id: "subA", cycle_close: "2026-08-15", total_fee_cents: 100, line_count: 1, status: "failed", attempts: 5, max_attempts: 5, stripe_invoice_id: "in_x", stripe_idempotency_key: "k" },
      ],
      subscribers: [{ id: "subA", subscription_status: "active", test_user: false, stripe_customer_id: "cus_1" }],
    });
    const res = await drainSettlements({ dryRun: false }, client, neverCallStripe);
    expect(res.candidates).toBe(0); // dead-letter excluded → Stripe never touched
  });

  it("charging path: decline bumps attempts and dead-letters at max_attempts", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    const { client, updates } = makeDb({
      app_config: { value: true }, // kill-switch ON
      fee_settlements: [
        // attempts 4, max 5 → retryable; a decline makes attempts 5 → dead-letter.
        { id: "set1", subscriber_id: "subA", cycle_close: "2026-08-15", total_fee_cents: 444, line_count: 2, status: "failed", attempts: 4, max_attempts: 5, stripe_invoice_id: "in_prev", stripe_idempotency_key: "settle_subA_2026-08-15" },
      ],
      subscribers: [{ id: "subA", subscription_status: "active", test_user: false, stripe_customer_id: "cus_1" }],
      fee_settlement_lines: [
        { settlement_id: "set1", ledger_row_id: "l1", fee_cents: 333 },
        { settlement_id: "set1", ledger_row_id: "l2", fee_cents: 111 },
      ],
      rev_share_ledger: [
        { id: "l1", invoice_ref: "145", invoice_number: "1038", dollars_recovered: 3900, band: "band1", rate: 0.22 },
        { id: "l2", invoice_ref: "146", invoice_number: null, dollars_recovered: 500, band: "band1", rate: 0.22 },
      ],
    });
    const declineStripe = makeStripe({ payInvoice: async () => { throw new Error("card_declined"); } }).stripe;

    const res = await drainSettlements({ dryRun: false }, client, declineStripe);
    expect(res.charging).toBe(true);
    expect(res.failed).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ settlementId: "set1", action: "dead_letter" });
    // attempts written as 5 (==max) → will not be re-selected next run.
    expect(updates[0].payload).toMatchObject({ status: "failed", attempts: 5 });
  });

  it("charging path: happy path marks paid + stores stripe_invoice_id", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    const { client, updates } = makeDb({
      app_config: { value: true },
      fee_settlements: [
        { id: "set1", subscriber_id: "subA", cycle_close: "2026-08-15", total_fee_cents: 444, line_count: 2, status: "pending", attempts: 0, max_attempts: 5, stripe_invoice_id: null, stripe_idempotency_key: "settle_subA_2026-08-15" },
      ],
      subscribers: [{ id: "subA", subscription_status: "active", test_user: false, stripe_customer_id: "cus_1" }],
      fee_settlement_lines: [
        { settlement_id: "set1", ledger_row_id: "l1", fee_cents: 333 },
        { settlement_id: "set1", ledger_row_id: "l2", fee_cents: 111 },
      ],
      rev_share_ledger: [
        { id: "l1", invoice_ref: "145", invoice_number: "1038", dollars_recovered: 3900, band: "band1", rate: 0.22 },
        { id: "l2", invoice_ref: "146", invoice_number: null, dollars_recovered: 500, band: "band1", rate: 0.22 },
      ],
    });
    const res = await drainSettlements({ dryRun: false }, client, makeStripe().stripe);
    expect(res.charged).toBe(1);
    expect(updates[0].payload).toMatchObject({ status: "paid", stripe_invoice_id: "in_test1" });
  });
});

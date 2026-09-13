import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chargeOneSettlement,
  claimForCharge,
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
    expect(calls.createInvoice).toEqual([{ customerId: "cus_123", key: "settle_subA_2026-08-15" }]);
    expect(calls.addInvoiceItem.map((a) => a.amountCents)).toEqual([333, 111]);
    expect(calls.addInvoiceItem.map((a) => a.idempotencyKey)).toEqual([
      "settle_subA_2026-08-15_line_l1",
      "settle_subA_2026-08-15_line_l2",
    ]);
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

// ── claimForCharge (single-flight compare-and-set) ────────────────────────────
type Result = { data: unknown; error: unknown };

describe("claimForCharge", () => {
  function makeClaimFake(result: Result) {
    const rec: { payload?: Record<string, unknown>; eqCol?: string; eqVal?: unknown; or?: string } = {};
    const b: Record<string, unknown> = {};
    b.update = (p: Record<string, unknown>) => { rec.payload = p; return b; };
    b.eq = (c: string, v: unknown) => { rec.eqCol = c; rec.eqVal = v; return b; };
    b.or = (e: string) => { rec.or = e; return b; };
    b.select = () => b;
    b.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR);
    return { client: { from: () => b } as never, rec };
  }

  it("true when the compare-and-set matched a row; issues the right update + predicate", async () => {
    const { client, rec } = makeClaimFake({ data: [{ id: "set1" }], error: null });
    const ok = await claimForCharge(client, "set1", Date.UTC(2026, 8, 13, 9, 0, 0));
    expect(ok).toBe(true);
    expect(rec.payload).toMatchObject({ status: "charging" });
    expect(typeof rec.payload!.claimed_at).toBe("string");
    expect(rec.eqCol).toBe("id");
    expect(rec.eqVal).toBe("set1");
    expect(rec.or).toContain("status.eq.pending");
    expect(rec.or).toContain("status.eq.failed");
    expect(rec.or).toMatch(/claimed_at\.lt\./);
  });

  it("false when no row matched (another run already claimed it)", async () => {
    const { client } = makeClaimFake({ data: [], error: null });
    expect(await claimForCharge(client, "set1")).toBe(false);
  });
});

// ── drainSettlements (DB-wired, claim-aware stateful stub) ────────────────────
function makeDb(tables: {
  app_config?: { value: unknown };
  fee_settlements?: Record<string, unknown>[];
  subscribers?: unknown[];
  fee_settlement_lines?: unknown[];
  rev_share_ledger?: unknown[];
}) {
  const updates: { id: unknown; payload: Record<string, unknown>; kind: string }[] = [];
  // Stateful fee_settlements so the claim compare-and-set is real.
  const feeRows = new Map((tables.fee_settlements ?? []).map((r) => [r.id as string, { ...r }]));

  const from = (table: string) => {
    const b: Record<string, unknown> = { _upd: false, _sel: false, _payload: undefined, _eqId: undefined, _or: undefined };
    b.select = () => { b._sel = true; return b; };
    b.in = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { if (col === "id") b._eqId = val; return b; };
    b.or = (expr: string) => { b._or = expr; return b; };
    b.update = (payload: Record<string, unknown>) => { b._upd = true; b._payload = payload; return b; };
    b.maybeSingle = () => b;
    b.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => {
      let res: Result;
      if (b._upd) {
        res = resolveUpdate(b);
      } else if (table === "app_config") {
        res = { data: tables.app_config ?? null, error: null };
      } else if (table === "fee_settlements") {
        res = { data: [...feeRows.values()], error: null };
      } else {
        res = { data: (tables as Record<string, unknown[]>)[table] ?? [], error: null };
      }
      return Promise.resolve(res).then(onF, onR);
    };
    return b;
  };

  function resolveUpdate(b: Record<string, unknown>): Result {
    const id = b._eqId as string;
    const payload = b._payload as Record<string, unknown>;
    const row = feeRows.get(id);
    const isClaim = payload?.status === "charging" && b._sel === true;
    if (isClaim) {
      const cutoff = /claimed_at\.lt\.([^,)]+)/.exec((b._or as string) ?? "")?.[1] ?? null;
      const claimable =
        !!row &&
        (row.status === "pending" ||
          row.status === "failed" ||
          (row.status === "charging" && cutoff !== null && (row.claimed_at == null || (row.claimed_at as string) < cutoff)));
      if (claimable && row) {
        row.status = "charging";
        row.claimed_at = payload.claimed_at;
        updates.push({ id, payload, kind: "claim" });
        return { data: [{ id }], error: null };
      }
      return { data: [], error: null };
    }
    if (row) Object.assign(row, payload);
    updates.push({ id, payload, kind: "mark" });
    return { data: null, error: null };
  }

  return { client: { from } as never, updates, feeRows };
}

const feeRow = (over: Record<string, unknown> = {}) => ({
  id: "set1",
  subscriber_id: "subA",
  cycle_close: "2026-08-15",
  total_fee_cents: 444,
  line_count: 2,
  status: "pending",
  attempts: 0,
  max_attempts: 5,
  stripe_invoice_id: null,
  stripe_idempotency_key: "settle_subA_2026-08-15",
  claimed_at: null,
  ...over,
});
const subRow = (over: Record<string, unknown> = {}) => ({
  id: "subA",
  subscription_status: "active",
  test_user: false,
  stripe_customer_id: "cus_1",
  ...over,
});
const LINE_ROWS = [
  { settlement_id: "set1", ledger_row_id: "l1", fee_cents: 333 },
  { settlement_id: "set1", ledger_row_id: "l2", fee_cents: 111 },
];
const LEDGER_ROWS = [
  { id: "l1", invoice_ref: "145", invoice_number: "1038", dollars_recovered: 3900, band: "band1", rate: 0.22 },
  { id: "l2", invoice_ref: "146", invoice_number: null, dollars_recovered: 500, band: "band1", rate: 0.22 },
];
const prodLive = () => {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
};
const marks = (updates: { kind: string; payload: Record<string, unknown> }[]) =>
  updates.filter((u) => u.kind === "mark");

describe("drainSettlements — gates & flags", () => {
  it("charging flag OFF (default dryRun) → forced dry-run: no Stripe, no writes", async () => {
    prodLive();
    const { client, updates } = makeDb({
      app_config: { value: false }, // settlement_charging_enabled = false
      fee_settlements: [feeRow()],
      subscribers: [subRow()],
      fee_settlement_lines: LINE_ROWS,
      rev_share_ledger: LEDGER_ROWS,
    });
    const res = await drainSettlements({}, client, neverCallStripe); // dryRun defaults true
    expect(res.charging).toBe(false);
    expect(res.candidates).toBe(1);
    expect(res.charged).toBe(0);
    expect(updates).toHaveLength(0);
    expect(res.outcomes[0]).toMatchObject({ action: "dry_run" });
  });

  it("charging flag ON + prod + live + dryRun=false → charges, marks paid", async () => {
    prodLive();
    const { client, updates } = makeDb({
      app_config: { value: true },
      fee_settlements: [feeRow()],
      subscribers: [subRow()],
      fee_settlement_lines: LINE_ROWS,
      rev_share_ledger: LEDGER_ROWS,
    });
    const res = await drainSettlements({ dryRun: false }, client, makeStripe().stripe);
    expect(res.charging).toBe(true);
    expect(res.charged).toBe(1);
    expect(marks(updates)[0].payload).toMatchObject({ status: "paid", stripe_invoice_id: "in_test1" });
  });

  it("charging flag ON but NOT prod/live → forced dry-run, no charge", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    const { client, updates } = makeDb({
      app_config: { value: true },
      fee_settlements: [feeRow()],
      subscribers: [subRow()],
      fee_settlement_lines: LINE_ROWS,
      rev_share_ledger: LEDGER_ROWS,
    });
    const res = await drainSettlements({ dryRun: false }, client, neverCallStripe);
    expect(res.charging).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("test_user is never charged and is not even claimed (no write, no Stripe)", async () => {
    prodLive();
    const { client, updates } = makeDb({
      app_config: { value: true },
      fee_settlements: [feeRow()],
      subscribers: [subRow({ test_user: true })],
      fee_settlement_lines: LINE_ROWS,
      rev_share_ledger: LEDGER_ROWS,
    });
    const res = await drainSettlements({ dryRun: false }, client, neverCallStripe);
    expect(res.skipped).toBe(1);
    expect(updates).toHaveLength(0); // never claimed
    expect(res.outcomes[0]).toMatchObject({ action: "skipped", reason: "test_user" });
  });

  it("dead-lettered settlement (failed, attempts == max) is not selected", async () => {
    prodLive();
    const { client } = makeDb({
      app_config: { value: true },
      fee_settlements: [feeRow({ status: "failed", attempts: 5, max_attempts: 5, stripe_invoice_id: "in_x" })],
      subscribers: [subRow()],
    });
    const res = await drainSettlements({ dryRun: false }, client, neverCallStripe);
    expect(res.candidates).toBe(0);
  });

  it("decline bumps attempts and dead-letters at max_attempts", async () => {
    prodLive();
    const { client, updates } = makeDb({
      app_config: { value: true },
      fee_settlements: [feeRow({ status: "failed", attempts: 4, max_attempts: 5, stripe_invoice_id: "in_prev" })],
      subscribers: [subRow()],
      fee_settlement_lines: LINE_ROWS,
      rev_share_ledger: LEDGER_ROWS,
    });
    const declineStripe = makeStripe({ payInvoice: async () => { throw new Error("card_declined"); } }).stripe;
    const res = await drainSettlements({ dryRun: false }, client, declineStripe);
    expect(res.failed).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ settlementId: "set1", action: "dead_letter" });
    expect(marks(updates)[0].payload).toMatchObject({ status: "failed", attempts: 5 });
  });
});

describe("drainSettlements — single-flight", () => {
  it("a FRESH 'charging' claim (another run holds it) is not re-selected", async () => {
    prodLive();
    const { client } = makeDb({
      app_config: { value: true },
      fee_settlements: [feeRow({ status: "charging", claimed_at: new Date().toISOString() })],
      subscribers: [subRow()],
      fee_settlement_lines: LINE_ROWS,
      rev_share_ledger: LEDGER_ROWS,
    });
    const res = await drainSettlements({ dryRun: false }, client, neverCallStripe);
    expect(res.candidates).toBe(0); // fresh claim held by someone else → skipped at selection
  });

  it("a STALE 'charging' claim (crashed run) is reclaimed and charged", async () => {
    prodLive();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const { client, updates } = makeDb({
      app_config: { value: true },
      fee_settlements: [feeRow({ status: "charging", claimed_at: stale })],
      subscribers: [subRow()],
      fee_settlement_lines: LINE_ROWS,
      rev_share_ledger: LEDGER_ROWS,
    });
    const res = await drainSettlements({ dryRun: false }, client, makeStripe().stripe);
    expect(res.candidates).toBe(1);
    expect(res.charged).toBe(1);
    // Re-claimed (kind:'claim') then marked paid (kind:'mark').
    expect(updates.some((u) => u.kind === "claim")).toBe(true);
    expect(marks(updates)[0].payload).toMatchObject({ status: "paid" });
  });
});

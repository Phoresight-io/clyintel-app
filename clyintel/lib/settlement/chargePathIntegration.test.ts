// Layer 1 — deterministic charge-path integration test (default CI, NO network).
//
// Drives a fixture fee_settlements + fee_settlement_lines through the real
// drainSettlements → chargeOneSettlement flow with:
//   • the env/live gate INJECTED as () => true (the Part-A seam) so the charge
//     branch runs against an sk_test key with NO production env — the production
//     default gate is never touched here;
//   • a fake StripeInvoicing recorder (every call captured, no network);
//   • the shared in-memory fake Supabase (lib/settlement/testSupport/fakeSupabase),
//     seeded settlement_charging_enabled=true and an active non-test subscriber.
// Then it synthesizes the tagged invoice.payment_succeeded / _failed events and
// drives them through the #117 webhook reconcilers (which read getSupabase()),
// pointed at the SAME fake so the invoiced→paid/→failed flip lands on the same row.
//
// Everything is in-memory: NO writes to the shared Supabase project, NO Stripe
// network. See chargePathSmoke.test.ts for the env-gated real-test-mode smoke.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted holder + module mock so the webhook reconcilers' internal getSupabase()
// resolves to the same fake we hand drainSettlements explicitly.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => h.client }));

import {
  drainSettlements,
  claimForCharge,
  type StripeInvoicing,
} from "@/lib/settlement/chargeSettlement";
import {
  handleSettlementInvoicePaid,
  handleSettlementInvoiceFailed,
} from "@/app/api/stripe-webhook/route";
import { makeFakeSupabase, type Row } from "@/lib/settlement/testSupport/fakeSupabase";

// ── fake Stripe recorder ──────────────────────────────────────────────────────
function makeStripe(over: Partial<StripeInvoicing> = {}) {
  const calls = {
    createInvoice: [] as { customerId: string; key: string; metadata?: Record<string, string> }[],
    addInvoiceItem: [] as Parameters<StripeInvoicing["addInvoiceItem"]>[0][],
    finalizeInvoice: [] as string[],
    payInvoice: [] as string[],
  };
  const stripe: StripeInvoicing = {
    createInvoice: async (customerId, key, metadata) => {
      calls.createInvoice.push({ customerId, key, metadata });
      return { id: "in_layer1" };
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
const neverStripe: StripeInvoicing = {
  createInvoice: async () => { throw new Error("Stripe must not be called"); },
  addInvoiceItem: async () => { throw new Error("Stripe must not be called"); },
  finalizeInvoice: async () => { throw new Error("Stripe must not be called"); },
  payInvoice: async () => { throw new Error("Stripe must not be called"); },
};

// ── DB fixtures ───────────────────────────────────────────────────────────────
const feeSeed = (over: Record<string, unknown> = {}): Row => ({
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
const subSeed = (over: Record<string, unknown> = {}): Row => ({
  id: "subA",
  subscription_status: "active",
  test_user: false,
  stripe_customer_id: "cus_1",
  ...over,
});
const LINE_ROWS: Row[] = [
  { settlement_id: "set1", ledger_row_id: "l1", fee_cents: 333 },
  { settlement_id: "set1", ledger_row_id: "l2", fee_cents: 111 },
];
const LEDGER_ROWS: Row[] = [
  { id: "l1", invoice_ref: "145", invoice_number: "1038", dollars_recovered: 3900, band: "band1", rate: 0.22 },
  { id: "l2", invoice_ref: "146", invoice_number: null, dollars_recovered: 500, band: "band1", rate: 0.22 },
];

// Seed the shared fake, wire it into the getSupabase() mock, and return it.
function setup(opts: {
  fee?: Record<string, unknown>;
  sub?: Record<string, unknown>;
  lines?: Row[];
  charging?: boolean;
} = {}) {
  const fake = makeFakeSupabase({
    settlements: [feeSeed(opts.fee)],
    subscribers: [subSeed(opts.sub)],
    lines: opts.lines ?? LINE_ROWS,
    ledger: LEDGER_ROWS,
    appConfig: { settlement_charging_enabled: opts.charging ?? true },
  });
  h.client = fake.client;
  return fake;
}

// service seam the production code accepts (strip the defaulted param's undefined).
type Svc = NonNullable<Parameters<typeof drainSettlements>[1]>;
const svc = (fake: ReturnType<typeof setup>) => fake.client as unknown as Svc;
// gate seam: exercise the real charge branch WITHOUT prod env / sk_live.
const GATE_ON = { liveChargesAllowed: () => true } as const;

const noPaymentsWrite = (writes: { table: string }[]) => writes.every((w) => w.table !== "payments");

beforeEach(() => { h.client = null; });

// ── status machine + gate seam ────────────────────────────────────────────────
describe("Layer 1 — status machine (pending → charging → invoiced → paid)", () => {
  it("charges via the injected gate with a non-prod env and sk_test-style key; no real gate needed", async () => {
    // Prove the injected seam is what enables charging: production env is absent.
    expect(process.env.VERCEL_ENV).not.toBe("production");
    const fake = setup();
    const { stripe, calls } = makeStripe();

    const res = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);

    expect(res.charging).toBe(true);
    expect(res.charged).toBe(1);
    // invoiced: created once (tagged), one item per line, finalized, then paid.
    expect(calls.createInvoice).toHaveLength(1);
    expect(calls.createInvoice[0].metadata).toMatchObject({ kind: "fee_settlement", settlement_id: "set1" });
    expect(calls.addInvoiceItem.map((a) => a.amountCents)).toEqual([333, 111]);
    expect(calls.finalizeInvoice).toEqual(["in_layer1"]);
    expect(calls.payInvoice).toEqual(["in_layer1"]);
    // terminal DB state.
    const row = fake.feeRows.get("set1")!;
    expect(row.status).toBe("paid");
    expect(row.stripe_invoice_id).toBe("in_layer1");
    // the row transitioned pending → charging (single-flight claim) → paid.
    const statuses = fake.writes.filter((w) => w.table === "fee_settlements").map((w) => (w.payload as Row).status);
    expect(statuses).toContain("charging");
    expect(statuses).toContain("paid");
    // never touched the subscription payments rail.
    expect(noPaymentsWrite(fake.writes)).toBe(true);
  });
});

// ── idempotency / resume ──────────────────────────────────────────────────────
describe("Layer 1 — idempotency & resume (no duplicate invoice / items)", () => {
  it("a re-run charges nothing again: createInvoice stays at one, payInvoice at one", async () => {
    const fake = setup();
    const { stripe, calls } = makeStripe();

    const first = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);
    expect(first.charged).toBe(1);

    // Second identical drain: the row is now 'paid' → not a candidate → no work.
    const second = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);
    expect(second.candidates).toBe(0);
    expect(second.charged).toBe(0);

    // Across BOTH runs: exactly one invoice and one payment attempt — no duplicates.
    expect(calls.createInvoice).toHaveLength(1);
    expect(calls.addInvoiceItem).toHaveLength(2);
    expect(calls.payInvoice).toHaveLength(1);
  });

  it("resume: a settlement already finalized (stripe_invoice_id set) skips create/finalize and only pays", async () => {
    const fake = setup({ fee: { status: "failed", attempts: 1, stripe_invoice_id: "in_prev" } });
    const { stripe, calls } = makeStripe();

    const res = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);

    expect(res.charged).toBe(1);
    expect(calls.createInvoice).toHaveLength(0); // no second invoice
    expect(calls.addInvoiceItem).toHaveLength(0); // no duplicate items
    expect(calls.finalizeInvoice).toHaveLength(0);
    expect(calls.payInvoice).toEqual(["in_prev"]); // resumes straight at pay
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
  });
});

// ── reconcile gate ────────────────────────────────────────────────────────────
describe("Layer 1 — reconcile gate blocks a corrupt settlement before any charge", () => {
  it("line_count/sum mismatch → status failed with ZERO StripeInvoicing calls", async () => {
    // lines sum to 444 but the settlement claims 999 → integrity mismatch.
    const fake = setup({ fee: { total_fee_cents: 999 } });
    const { stripe, calls } = makeStripe();

    const res = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);

    expect(res.failed).toBe(1);
    expect(res.charged).toBe(0);
    expect(fake.feeRows.get("set1")!.status).toBe("failed");
    // NOT charged: no invoice was ever created / finalized / paid.
    expect(calls.createInvoice).toHaveLength(0);
    expect(calls.addInvoiceItem).toHaveLength(0);
    expect(calls.finalizeInvoice).toHaveLength(0);
    expect(calls.payInvoice).toHaveLength(0);
  });
});

// ── failed branch ─────────────────────────────────────────────────────────────
describe("Layer 1 — failed branch (decline after finalize)", () => {
  it("payInvoice throws → invoiced then failed, stripe_invoice_id retained, attempts++", async () => {
    const fake = setup();
    const { stripe, calls } = makeStripe({
      payInvoice: async () => { throw new Error("card_declined"); },
    });

    const res = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);

    expect(res.failed).toBe(1);
    expect(calls.finalizeInvoice).toEqual(["in_layer1"]); // reached 'invoiced'
    const row = fake.feeRows.get("set1")!;
    expect(row.status).toBe("failed");
    expect(row.stripe_invoice_id).toBe("in_layer1"); // retained so a retry resumes at pay
    expect(row.attempts).toBe(1);
    expect(String(row.last_error)).toMatch(/payment: card_declined/);
  });
});

// ── single-flight ─────────────────────────────────────────────────────────────
describe("Layer 1 — single-flight claim", () => {
  it("a FRESH 'charging' claim (held by another run) is not re-selected", async () => {
    const fake = setup({ fee: { status: "charging", claimed_at: new Date().toISOString() } });
    const res = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), neverStripe);
    expect(res.candidates).toBe(0);
  });

  it("a STALE 'charging' claim (>15 min, crashed run) is reclaimed and charged", async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const fake = setup({ fee: { status: "charging", claimed_at: stale } });
    const { stripe } = makeStripe();
    const res = await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);
    expect(res.candidates).toBe(1);
    expect(res.charged).toBe(1);
    expect(fake.writes.some((w) => w.table === "fee_settlements" && (w.payload as Row).status === "charging")).toBe(true);
  });

  it("compare-and-set: a second concurrent claim on the same row is refused", async () => {
    const fake = setup();
    const first = await claimForCharge(svc(fake), "set1");
    const second = await claimForCharge(svc(fake), "set1"); // now FRESH 'charging' → refused
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

// ── webhook reconcile (same fake, via getSupabase() mock) ─────────────────────
const settlementEvent = (over: Record<string, unknown> = {}) => ({
  id: "in_wh",
  customer: "cus_1", // present to prove the reconciler ignores the customer-id fallback
  metadata: { kind: "fee_settlement", settlement_id: "set1", subscriber_id: "subA", cycle_close: "2026-08-15" },
  ...over,
});

describe("Layer 1 — webhook reconcile flips invoiced → paid / → failed", () => {
  it("tagged invoice.payment_succeeded flips a non-terminal settlement to paid; payments never written", async () => {
    const fake = setup({ fee: { status: "charging", stripe_invoice_id: "in_wh" } });
    await handleSettlementInvoicePaid(settlementEvent(), "evt_ok");

    const row = fake.feeRows.get("set1")!;
    expect(row.status).toBe("paid");
    expect(row.stripe_invoice_id).toBe("in_wh");
    expect(noPaymentsWrite(fake.writes)).toBe(true);
    expect([...new Set(fake.writes.map((w) => w.table))].sort()).toEqual(["audit_log", "fee_settlements"]);
  });

  it("tagged invoice.payment_failed flips to failed; replay is idempotent (one audit row); no payments write", async () => {
    const fake = setup({ fee: { status: "charging", stripe_invoice_id: "in_wh" } });
    await handleSettlementInvoiceFailed(settlementEvent(), "evt_f");
    await handleSettlementInvoiceFailed(settlementEvent(), "evt_f"); // replay

    expect(fake.feeRows.get("set1")!.status).toBe("failed");
    expect(
      fake.auditRows.filter((a) => a.action === "settlement_invoice_failed" && a.payload.stripe_event_id === "evt_f"),
    ).toHaveLength(1);
    expect(noPaymentsWrite(fake.writes)).toBe(true);
  });

  it("end-to-end: sync charge marks paid, then a redelivered failed webhook is a guarded no-op (stays paid)", async () => {
    const fake = setup();
    const { stripe } = makeStripe();
    await drainSettlements({ dryRun: false, ...GATE_ON }, svc(fake), stripe);
    expect(fake.feeRows.get("set1")!.status).toBe("paid");

    // A late invoice.payment_failed redelivery must never regress a paid row.
    await handleSettlementInvoiceFailed(settlementEvent({ id: "in_layer1" }), "evt_late");
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
    expect(noPaymentsWrite(fake.writes)).toBe(true);
  });
});

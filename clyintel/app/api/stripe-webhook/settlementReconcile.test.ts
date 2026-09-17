import { describe, it, expect, vi, beforeEach } from "vitest";

// The reconcilers call getSupabase() internally, so we module-mock @/lib/supabase
// to hand back a stateful fake client (the cron/route.test.ts approach). A hoisted
// holder lets each test install its own fake. No real DB or Stripe is touched.
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => h.client }));

import {
  isFeeSettlementInvoice,
  handleSettlementInvoicePaid,
  handleSettlementInvoiceFailed,
  handleSettlementRefundEvent,
  handleSettlementInvoiceVoided,
} from "./route";
// The stateful in-memory fake now lives in a shared test-support module so the
// Layer-1 charge-path integration test and this #117 suite drive one fake. It
// models fee_settlements (select + guarded/claim update) and audit_log
// (select + insert), capturing every write so `payments` can be asserted absent.
import { makeFakeSupabase, type Row, type AuditRow } from "@/lib/settlement/testSupport/fakeSupabase";

type FeeRow = Row & {
  id: string;
  subscriber_id: string;
  status: string;
  attempts?: number;
  stripe_invoice_id?: string | null;
  last_error?: string | null;
};

const install = (seed?: { settlements?: FeeRow[]; audit?: AuditRow[]; refunds?: Row[] }) => {
  const fake = makeFakeSupabase(seed);
  h.client = fake.client;
  return fake;
};

// ── fixtures ──────────────────────────────────────────────────────────────────
const settlementInvoice = (over: Record<string, unknown> = {}) => ({
  id: "in_test",
  customer: "cus_sub", // present, to prove the reconciler ignores the customer-id fallback
  metadata: { kind: "fee_settlement", settlement_id: "set1", subscriber_id: "sub1", cycle_close: "2026-08-15" },
  ...over,
});
const nonSettlementInvoice = () => ({ id: "in_sub", customer: "cus_sub", metadata: { foo: "bar" } });
const feeRow = (over: Partial<FeeRow> = {}): FeeRow => ({
  id: "set1", subscriber_id: "sub1", status: "charging", attempts: 0, stripe_invoice_id: null, last_error: null, ...over,
});
const noPaymentsWrite = (writes: { table: string }[]) => writes.every((w) => w.table !== "payments");

beforeEach(() => { h.client = null; });

// ── routing ──────────────────────────────────────────────────────────────────
describe("isFeeSettlementInvoice (routing predicate)", () => {
  it("true for a tagged settlement invoice", () => {
    expect(isFeeSettlementInvoice(settlementInvoice())).toBe(true);
  });
  it("false for a non-settlement invoice and for missing metadata", () => {
    expect(isFeeSettlementInvoice(nonSettlementInvoice())).toBe(false);
    expect(isFeeSettlementInvoice({})).toBe(false);
    expect(isFeeSettlementInvoice({ metadata: { kind: "subscription_cycle" } })).toBe(false);
  });
});

// ── paid handler ─────────────────────────────────────────────────────────────
describe("handleSettlementInvoicePaid", () => {
  it("marks the settlement paid, stores stripe_invoice_id, audits — and writes NO payments row", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging" })] });
    await handleSettlementInvoicePaid(settlementInvoice({ id: "in_paid" }), "evt_1");

    const row = fake.feeRows.get("set1")!;
    expect(row.status).toBe("paid");
    expect(row.stripe_invoice_id).toBe("in_paid");
    expect(row.last_error).toBeNull();
    // audit written for this event; NEVER a payments row (no subscription-rail leakage).
    expect(fake.auditRows.some((a) => a.action === "settlement_invoice_paid" && a.payload.stripe_event_id === "evt_1")).toBe(true);
    expect(noPaymentsWrite(fake.writes)).toBe(true);
    expect(fake.writes.map((w) => w.table).sort()).toEqual(["audit_log", "fee_settlements"]);
  });

  it("crash-window rescue: fills a NULL stripe_invoice_id", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging", stripe_invoice_id: null })] });
    await handleSettlementInvoicePaid(settlementInvoice({ id: "in_rescue" }), "evt_r");
    expect(fake.feeRows.get("set1")!.stripe_invoice_id).toBe("in_rescue");
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
  });

  it("terminal-state guard: a 'void' settlement is never transitioned", async () => {
    const fake = install({ settlements: [feeRow({ status: "void" })] });
    await handleSettlementInvoicePaid(settlementInvoice(), "evt_v");
    expect(fake.feeRows.get("set1")!.status).toBe("void"); // unchanged
    expect(fake.writes.some((w) => w.table === "fee_settlements")).toBe(false); // guarded no-op
  });

  it("missing settlement_id → no-op, no writes", async () => {
    const fake = install({ settlements: [feeRow()] });
    await handleSettlementInvoicePaid({ id: "in_x", metadata: { kind: "fee_settlement" } }, "evt_m");
    expect(fake.writes).toHaveLength(0);
  });

  it("settlement not found → no-op, no writes", async () => {
    const fake = install({ settlements: [] });
    await handleSettlementInvoicePaid(settlementInvoice(), "evt_nf");
    expect(fake.writes).toHaveLength(0);
  });

  it("event dedup: the same stripe_event_id twice has a single effect (one audit row)", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging" })] });
    await handleSettlementInvoicePaid(settlementInvoice({ id: "in_d" }), "evt_dup");
    await handleSettlementInvoicePaid(settlementInvoice({ id: "in_d" }), "evt_dup");
    expect(fake.auditRows.filter((a) => a.action === "settlement_invoice_paid" && a.payload.stripe_event_id === "evt_dup")).toHaveLength(1);
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
  });
});

// ── failed handler ───────────────────────────────────────────────────────────
describe("handleSettlementInvoiceFailed", () => {
  it("marks failed, leaves attempts untouched, stores invoice id — no payments row", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging", attempts: 0 })] });
    await handleSettlementInvoiceFailed(settlementInvoice({ id: "in_f" }), "evt_f");
    const row = fake.feeRows.get("set1")!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(0); // webhook reconciles the outcome; the sync path owns the counter
    expect(row.stripe_invoice_id).toBe("in_f");
    expect(row.last_error).toBe("webhook_payment_failed");
    expect(noPaymentsWrite(fake.writes)).toBe(true);
  });

  it("never overrides a paid row (paid-then-failed stays paid)", async () => {
    const fake = install({ settlements: [feeRow({ status: "paid", stripe_invoice_id: "in_paid" })] });
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_late_fail");
    expect(fake.feeRows.get("set1")!.status).toBe("paid"); // no regression
  });

  it("failed event redelivery is idempotent: same event twice has a single effect (one audit row)", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging", attempts: 0 })] });
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_ff");
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_ff");
    expect(fake.auditRows.filter((a) => a.action === "settlement_invoice_failed" && a.payload.stripe_event_id === "evt_ff")).toHaveLength(1);
    expect(fake.feeRows.get("set1")!.attempts).toBe(0); // no bump on either delivery
  });
});

// ── first-writer-wins across the two handlers ────────────────────────────────
describe("first-writer-wins (sync vs webhook orderings both end paid)", () => {
  it("failed-then-paid → ends paid", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging", attempts: 0 })] });
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_1"); // → failed (non-terminal)
    await handleSettlementInvoicePaid(settlementInvoice({ id: "in_win" }), "evt_2"); // → paid
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
    expect(fake.feeRows.get("set1")!.stripe_invoice_id).toBe("in_win");
  });

  it("paid-then-redelivered(failed) → stays paid, never regresses", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging" })] });
    await handleSettlementInvoicePaid(settlementInvoice({ id: "in_p" }), "evt_p"); // → paid
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_late"); // guarded no-op
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
  });
});

// ── attempts idempotency (fixed in 5c) ───────────────────────────────────────
// A single failed charge attempt must be counted once against max_attempts. The
// synchronous path (chargeSettlement) owns the attempt counter — it bumps attempts
// on the payInvoice throw. The invoice.payment_failed webhook only reconciles the
// outcome, so it no longer bumps attempts (5c removed that write). This test is the
// acceptance test for that fix: sync failure at N+1 + the webhook for the SAME
// attempt leaves attempts at N+1, not N+2.
describe("attempts idempotency across sync + webhook", () => {
  it("sync failure (attempts N→N+1) + invoice.payment_failed for the SAME attempt leaves attempts at N+1, not N+2", async () => {
    // Post-sync-failure state for attempt #1: the drainer already wrote attempts=1.
    const fake = install({ settlements: [feeRow({ status: "failed", attempts: 1, stripe_invoice_id: "in_same" })] });
    // The webhook for the SAME declined invoice arrives.
    await handleSettlementInvoiceFailed(settlementInvoice({ id: "in_same" }), "evt_same_attempt");
    // Idempotent on attempts for one attempt: the webhook no longer bumps, so it stays at 1.
    expect(fake.feeRows.get("set1")!.attempts).toBe(1);
  });
});

// ── Refund reconciliation (Part B — async settle + void rescue) ───────────────
const refundRow = (over: Record<string, unknown> = {}): Row => ({
  id: "rr1",
  settlement_id: "set1",
  kind: "refund",
  amount_cents: 444,
  status: "pending",
  stripe_idempotency_key: "refund_set1",
  stripe_refund_id: "re_1",
  ...over,
});
const refundEvt = (over: Record<string, unknown> = {}) => ({ id: "re_1", status: "succeeded", ...over });

describe("handleSettlementRefundEvent (async refund settle)", () => {
  it("succeeded from refund_pending → settlement 'refunded', row 'succeeded', one audit, payments untouched", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refund_pending" })],
      refunds: [refundRow({ status: "pending" })],
    });
    const matched = await handleSettlementRefundEvent("re_1", "succeeded", "evt_rs");
    expect(matched).toBe(true);
    expect(fake.feeRows.get("set1")!.status).toBe("refunded");
    expect(fake.refundRows[0]).toMatchObject({ status: "succeeded" });
    expect(fake.auditRows.filter((a) => a.action === "settlement_refund_succeeded" && a.payload.stripe_event_id === "evt_rs")).toHaveLength(1);
    expect(noPaymentsWrite(fake.writes)).toBe(true);
  });

  it("failed from refund_pending → settlement back to 'paid', row 'failed'", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refund_pending" })],
      refunds: [refundRow({ status: "pending" })],
    });
    const matched = await handleSettlementRefundEvent("re_1", "failed", "evt_rf");
    expect(matched).toBe(true);
    expect(fake.feeRows.get("set1")!.status).toBe("paid");
    expect(fake.refundRows[0]).toMatchObject({ status: "failed" });
  });

  it("dedup: same event id replayed → no second transition, no dup audit", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refund_pending" })],
      refunds: [refundRow({ status: "pending" })],
    });
    await handleSettlementRefundEvent("re_1", "succeeded", "evt_dup");
    await handleSettlementRefundEvent("re_1", "succeeded", "evt_dup");
    expect(fake.auditRows.filter((a) => a.action === "settlement_refund_succeeded" && a.payload.stripe_event_id === "evt_dup")).toHaveLength(1);
    expect(fake.feeRows.get("set1")!.status).toBe("refunded");
  });

  it("terminal guard: already 'refunded' + late event → no settlement transition (0 rows moved)", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refunded" })],
      refunds: [refundRow({ status: "succeeded" })],
    });
    await handleSettlementRefundEvent("re_1", "succeeded", "evt_late");
    expect(fake.feeRows.get("set1")!.status).toBe("refunded"); // unchanged; positive guard matched 0 rows
    expect(fake.writes.some((w) => w.table === "fee_settlements")).toBe(false); // no settlement mutation
  });

  it("non-terminal refund status (pending) → no-op, matched", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refund_pending" })],
      refunds: [refundRow({ status: "pending" })],
    });
    const matched = await handleSettlementRefundEvent("re_1", "pending", "evt_np");
    expect(matched).toBe(true);
    expect(fake.feeRows.get("set1")!.status).toBe("refund_pending"); // nothing to settle yet
    expect(fake.writes).toHaveLength(0);
  });

  it("not a settlement refund id → returns false (charge.refunded caller falls through to payments)", async () => {
    const fake = install({ settlements: [feeRow({ status: "refund_pending" })], refunds: [refundRow()] });
    const matched = await handleSettlementRefundEvent("re_OTHER", "succeeded", "evt_x");
    expect(matched).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  it("NULL stripe_refund_id row → event finds no match → no-op (left for resume)", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refund_pending" })],
      refunds: [refundRow({ stripe_refund_id: null })],
    });
    const matched = await handleSettlementRefundEvent("re_1", "succeeded", "evt_null");
    expect(matched).toBe(false);
    expect(fake.feeRows.get("set1")!.status).toBe("refund_pending");
    expect(fake.writes).toHaveLength(0);
  });
});

describe("handleSettlementInvoiceVoided (post-Stripe void crash rescue)", () => {
  it("mid-void 'refund_pending' → settlement 'void', void row 'succeeded', one audit", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refund_pending" })],
      refunds: [refundRow({ kind: "void", status: "pending", stripe_refund_id: null, stripe_idempotency_key: "void_set1" })],
    });
    await handleSettlementInvoiceVoided(settlementInvoice(), "evt_void");
    expect(fake.feeRows.get("set1")!.status).toBe("void");
    expect(fake.refundRows[0]).toMatchObject({ kind: "void", status: "succeeded" });
    expect(fake.auditRows.filter((a) => a.action === "settlement_void_reconciled" && a.payload.stripe_event_id === "evt_void")).toHaveLength(1);
    expect(noPaymentsWrite(fake.writes)).toBe(true);
  });

  it("already 'void' → no-op (0 rows moved)", async () => {
    const fake = install({
      settlements: [feeRow({ status: "void" })],
      refunds: [refundRow({ kind: "void", status: "succeeded", stripe_refund_id: null })],
    });
    await handleSettlementInvoiceVoided(settlementInvoice(), "evt_void2");
    expect(fake.feeRows.get("set1")!.status).toBe("void");
    expect(fake.writes.some((w) => w.table === "fee_settlements")).toBe(false);
  });

  it("dedup: same void event replayed → single effect", async () => {
    const fake = install({
      settlements: [feeRow({ status: "refund_pending" })],
      refunds: [refundRow({ kind: "void", status: "pending", stripe_refund_id: null })],
    });
    await handleSettlementInvoiceVoided(settlementInvoice(), "evt_vd");
    await handleSettlementInvoiceVoided(settlementInvoice(), "evt_vd");
    expect(fake.auditRows.filter((a) => a.action === "settlement_void_reconciled" && a.payload.stripe_event_id === "evt_vd")).toHaveLength(1);
    expect(fake.feeRows.get("set1")!.status).toBe("void");
  });
});

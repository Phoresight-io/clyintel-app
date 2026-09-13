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
} from "./route";

// ── Stateful Supabase fake ────────────────────────────────────────────────────
// Models exactly the calls the reconcilers + writeAudit make:
//   fee_settlements: select(...).eq('id',_).maybeSingle()
//                    update({...}).eq('id',_).not('status','in','(paid,void)').select('id')
//   audit_log:       select('payload').eq('subscriber_id',_).eq('action',_)  (dedup)
//                    insert({...})
// It captures EVERY insert/update in `writes` so tests can assert which tables
// were (and were not) written — e.g. `payments` must never appear.
type FeeRow = {
  id: string;
  subscriber_id: string;
  status: string;
  attempts?: number;
  stripe_invoice_id?: string | null;
  last_error?: string | null;
};
type AuditRow = { subscriber_id: string; action: string; payload: Record<string, unknown> };

function makeFake(seed: { settlements?: FeeRow[]; audit?: AuditRow[] } = {}) {
  const feeRows = new Map<string, FeeRow>((seed.settlements ?? []).map((r) => [r.id, { ...r }]));
  const auditRows: AuditRow[] = (seed.audit ?? []).map((r) => ({ ...r }));
  const writes: { table: string; op: string; payload: unknown }[] = [];

  const matches = (row: Record<string, unknown>, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([k, v]) => row[k] === v);

  const passesNot = (row: Record<string, unknown>, col: string | null, vals: string | null) => {
    if (!col || !vals) return true;
    const list = vals.replace(/[()]/g, "").split(",");
    return !list.includes(row[col] as string);
  };

  function from(table: string) {
    const b: {
      table: string; op: string | null; payload: Record<string, unknown> | null;
      filters: Record<string, unknown>; single: boolean; ret: boolean; notCol: string | null; notVals: string | null;
      [k: string]: unknown;
    } = { table, op: null, payload: null, filters: {}, single: false, ret: false, notCol: null, notVals: null };
    b.select = () => { if (b.op === null) b.op = "select"; else b.ret = true; return b; };
    b.eq = (col: string, val: unknown) => { b.filters[col] = val; return b; };
    b.not = (col: string, _op: string, vals: string) => { b.notCol = col; b.notVals = vals; return b; };
    b.insert = (payload: Record<string, unknown>) => { b.op = "insert"; b.payload = payload; return b; };
    b.update = (payload: Record<string, unknown>) => { b.op = "update"; b.payload = payload; return b; };
    b.maybeSingle = () => { b.single = true; return b; };
    b.then = (onF: (v: { data: unknown; error: unknown }) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(b)).then(onF, onR);
    return b;
  }

  function resolve(b: {
    table: string; op: string | null; payload: Record<string, unknown> | null;
    filters: Record<string, unknown>; single: boolean; ret: boolean; notCol: string | null; notVals: string | null;
  }): { data: unknown; error: unknown } {
    if (b.table === "fee_settlements") {
      if (b.op === "select") {
        const rows = [...feeRows.values()].filter((r) => matches(r as Record<string, unknown>, b.filters));
        return { data: b.single ? (rows[0] ?? null) : rows, error: null };
      }
      if (b.op === "update") {
        const id = b.filters.id as string;
        const row = feeRows.get(id);
        if (row && passesNot(row as Record<string, unknown>, b.notCol, b.notVals)) {
          Object.assign(row, b.payload);
          writes.push({ table: b.table, op: "update", payload: b.payload });
          return { data: b.ret ? [{ id }] : null, error: null }; // applied
        }
        return { data: [], error: null }; // guard failed / missing → no-op
      }
    }
    if (b.table === "audit_log") {
      if (b.op === "select") {
        const rows = auditRows.filter((r) => matches(r as unknown as Record<string, unknown>, b.filters)).map((r) => ({ payload: r.payload }));
        return { data: rows, error: null };
      }
      if (b.op === "insert") {
        auditRows.push(b.payload as unknown as AuditRow);
        writes.push({ table: b.table, op: "insert", payload: b.payload });
        return { data: null, error: null };
      }
    }
    // Any other table (e.g. payments) — capture write attempts so tests can assert none.
    if (b.op === "insert" || b.op === "update") writes.push({ table: b.table, op: b.op, payload: b.payload });
    return { data: b.single ? null : [], error: null };
  }

  return { client: { from } as unknown, feeRows, auditRows, writes };
}

const install = (seed?: { settlements?: FeeRow[]; audit?: AuditRow[] }) => {
  const fake = makeFake(seed);
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
  it("marks failed, bumps attempts, stores invoice id — no payments row", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging", attempts: 0 })] });
    await handleSettlementInvoiceFailed(settlementInvoice({ id: "in_f" }), "evt_f");
    const row = fake.feeRows.get("set1")!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.stripe_invoice_id).toBe("in_f");
    expect(row.last_error).toBe("webhook_payment_failed");
    expect(noPaymentsWrite(fake.writes)).toBe(true);
  });

  it("never overrides a paid row (paid-then-failed stays paid)", async () => {
    const fake = install({ settlements: [feeRow({ status: "paid", stripe_invoice_id: "in_paid" })] });
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_late_fail");
    expect(fake.feeRows.get("set1")!.status).toBe("paid"); // no regression
  });

  it("failed event dedup: same event twice bumps attempts once", async () => {
    const fake = install({ settlements: [feeRow({ status: "charging", attempts: 0 })] });
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_ff");
    await handleSettlementInvoiceFailed(settlementInvoice(), "evt_ff");
    expect(fake.feeRows.get("set1")!.attempts).toBe(1);
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

// ── KNOWN BUG (do not fix in 5b) ──────────────────────────────────────────────
// A single failed charge attempt is counted twice against max_attempts: the
// synchronous path (chargeSettlement) bumps attempts on the payInvoice throw, and
// the invoice.payment_failed webhook for the SAME attempt bumps it again. Two
// write sites, no shared dedup key. This test encodes the DESIRED invariant
// (final attempts == N+1, not N+2). It is skipped because the fix is out of scope
// for 5b (test-only) — un-skipping it is the acceptance test for that fix.
describe("attempts double-count across sync + webhook (KNOWN BUG)", () => {
  it.skip("sync failure (attempts N→N+1) + invoice.payment_failed for the SAME attempt leaves attempts at N+1, not N+2", async () => {
    // Post-sync-failure state for attempt #1: the drainer already wrote attempts=1.
    const fake = install({ settlements: [feeRow({ status: "failed", attempts: 1, stripe_invoice_id: "in_same" })] });
    // The webhook for the SAME declined invoice arrives.
    await handleSettlementInvoiceFailed(settlementInvoice({ id: "in_same" }), "evt_same_attempt");
    // DESIRED: idempotent on attempts for one attempt. CURRENT code bumps to 2.
    expect(fake.feeRows.get("set1")!.attempts).toBe(1);
  });
});

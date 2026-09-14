import { describe, it, expect } from "vitest";
import { reconcileInvoiceFromCapture, type ReconcileInput } from "./reconcileInvoiceFromCapture";

// Stateful Supabase fake. Honors exactly the calls reconcile makes:
//   invoices:       .select(...).eq(subscriber_id).eq(source).eq(external_id).maybeSingle()
//                   .update(payload).eq("id", …)
//   balance_events: .select("new_outstanding_cents").eq("invoice_id",…).order().limit(1).maybeSingle()
//                   .insert(row)
// An inserted balance_event is retained so a SECOND reconcile reads it back as the
// anchor — this is what exercises idempotency/convergence for real.
function makeDb(invoiceRow: { id: string; external_id: string; amount_outstanding_cents: number; reminder_count: number } | null) {
  const balanceEventsByInvoice = new Map<string, Array<Record<string, unknown>>>();
  const writes = {
    invoiceUpdates: [] as Array<{ id: unknown; payload: Record<string, unknown> }>,
    balanceInserts: [] as Array<Record<string, unknown>>,
  };

  const from = (table: string) => {
    const ctx: { op: "select" | "insert" | "update"; eqs: [string, unknown][]; payload: unknown } = {
      op: "select",
      eqs: [],
      payload: null,
    };
    const resolve = () => {
      if (table === "invoices" && ctx.op === "select") {
        const ext = ctx.eqs.find(([c]) => c === "external_id")?.[1];
        const row = invoiceRow && invoiceRow.external_id === ext ? invoiceRow : null;
        return Promise.resolve({ data: row, error: null });
      }
      if (table === "invoices" && ctx.op === "update") {
        const id = ctx.eqs.find(([c]) => c === "id")?.[1];
        writes.invoiceUpdates.push({ id, payload: ctx.payload as Record<string, unknown> });
        return Promise.resolve({ data: null, error: null });
      }
      if (table === "balance_events" && ctx.op === "select") {
        const invId = String(ctx.eqs.find(([c]) => c === "invoice_id")?.[1]);
        const arr = balanceEventsByInvoice.get(invId) ?? [];
        const last = arr.length ? { new_outstanding_cents: arr[arr.length - 1].new_outstanding_cents } : null;
        return Promise.resolve({ data: last, error: null });
      }
      if (table === "balance_events" && ctx.op === "insert") {
        const row = ctx.payload as Record<string, unknown>;
        writes.balanceInserts.push(row);
        const invId = String(row.invoice_id);
        const arr = balanceEventsByInvoice.get(invId) ?? [];
        arr.push(row);
        balanceEventsByInvoice.set(invId, arr);
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (rows: unknown) => { ctx.op = "insert"; ctx.payload = rows; return builder; },
      update: (payload: unknown) => { ctx.op = "update"; ctx.payload = payload; return builder; },
      eq: (col: string, val: unknown) => { ctx.eqs.push([col, val]); return builder; },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => resolve(),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => resolve().then(onF, onR),
    };
    return builder;
  };

  return { client: { from } as never, writes };
}

const NOW = new Date("2026-09-14T00:00:00.000Z");
const baseInput = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  subscriberId: "sub_1",
  qboInvoiceId: "49",
  invoiceFaceCents: 95475,
  invoiceBalanceCents: 0,
  dueDate: "2026-06-26",
  ...over,
});

describe("reconcileInvoiceFromCapture", () => {
  it("full payment → status paid, amount_paid=face, in_recovery cleared, balance-drop emitted", async () => {
    const db = makeDb({ id: "inv1", external_id: "49", amount_outstanding_cents: 95475, reminder_count: 1 });
    const res = await reconcileInvoiceFromCapture(baseInput(), db.client, NOW);

    expect(res).toEqual({ status: "reconciled", balanceEventEmitted: true });
    expect(db.writes.invoiceUpdates).toHaveLength(1);
    expect(db.writes.invoiceUpdates[0]).toEqual({
      id: "inv1",
      payload: {
        status: "paid",
        amount_paid_cents: 95475, // face − balance(0)
        in_recovery: false,
        updated_at: NOW.toISOString(),
      },
    });
    // amount_outstanding_cents is GENERATED — never written.
    expect(db.writes.invoiceUpdates[0].payload).not.toHaveProperty("amount_outstanding_cents");
    expect(db.writes.balanceInserts).toHaveLength(1);
    expect(db.writes.balanceInserts[0]).toMatchObject({
      invoice_id: "inv1",
      source: "qbo",
      prev_outstanding_cents: 95475,
      new_outstanding_cents: 0,
      delta_cents: 95475,
      fee_eligible: true, // reminder_count 1 → outreach had fired
    });
  });

  it("partial payment → status partial, amount_paid=face−balance, drop emitted to the new balance", async () => {
    const db = makeDb({ id: "inv1", external_id: "49", amount_outstanding_cents: 95475, reminder_count: 0 });
    const res = await reconcileInvoiceFromCapture(baseInput({ invoiceBalanceCents: 20000 }), db.client, NOW);

    expect(res.status).toBe("reconciled");
    expect(db.writes.invoiceUpdates[0].payload).toMatchObject({
      status: "partial",
      amount_paid_cents: 75475, // 95475 − 20000
      in_recovery: false,
    });
    expect(db.writes.balanceInserts[0]).toMatchObject({
      prev_outstanding_cents: 95475,
      new_outstanding_cents: 20000,
      delta_cents: 75475,
      fee_eligible: false, // reminder_count 0 → outreach had not fired
    });
  });

  it("local invoice not synced yet → invoice_not_found, zero writes", async () => {
    const db = makeDb(null);
    const res = await reconcileInvoiceFromCapture(baseInput(), db.client, NOW);
    expect(res).toEqual({ status: "invoice_not_found", balanceEventEmitted: false });
    expect(db.writes.invoiceUpdates).toHaveLength(0);
    expect(db.writes.balanceInserts).toHaveLength(0);
  });

  it("IDEMPOTENT: reconciling the same capture twice CONVERGES — one balance_event, identical invoice writes", async () => {
    const db = makeDb({ id: "inv1", external_id: "49", amount_outstanding_cents: 95475, reminder_count: 1 });

    const first = await reconcileInvoiceFromCapture(baseInput(), db.client, NOW);
    const second = await reconcileInvoiceFromCapture(baseInput(), db.client, NOW);

    // First emits the drop; the second sees the ledger anchor (new_outstanding=0)
    // == the new outstanding → no further drop. This is exactly what a later
    // runQboSync (same anchor precedence, same QBO figures) would compute, so
    // capture + full-sync converge instead of double-counting.
    expect(first).toEqual({ status: "reconciled", balanceEventEmitted: true });
    expect(second).toEqual({ status: "reconciled", balanceEventEmitted: false });
    expect(db.writes.balanceInserts).toHaveLength(1); // NOT 2 — no duplicate drop
    expect(db.writes.invoiceUpdates).toHaveLength(2);
    expect(db.writes.invoiceUpdates[0]).toEqual(db.writes.invoiceUpdates[1]); // identical recompute
  });
});

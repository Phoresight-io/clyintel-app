import { describe, it, expect } from "vitest";
import { persistSettlements, settlementIdempotencyKey } from "./persistSettlements";
import type { SettlementPlan } from "./computeSettlements";

type Result = { data: unknown; error: unknown };

function makeFake(queues: Record<string, Result[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "upsert", "insert", "single", "maybeSingle"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return builder;
      };
    }
    builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => {
      const q = queues[table];
      if (!q || q.length === 0) {
        return Promise.reject(new Error(`no queued result for ${table}`)).then(onF, onR);
      }
      return Promise.resolve(q.shift() as Result).then(onF, onR);
    };
    return builder;
  };
  return { client: { from } as never, calls };
}

const plan: SettlementPlan = {
  subscriberId: "subA",
  cycleClose: "2026-08-15",
  totalFeeCents: 444,
  lineCount: 2,
  lines: [
    { ledgerRowId: "l1", feeCents: 333 },
    { ledgerRowId: "l2", feeCents: 111 },
  ],
  billable: true,
};

describe("settlementIdempotencyKey", () => {
  it("is deterministic per subscriber + cycle", () => {
    expect(settlementIdempotencyKey("subA", "2026-08-15")).toBe("settle_subA_2026-08-15");
  });
});

describe("persistSettlements", () => {
  it("new settlement: inserts fee_settlements (pending) + its lines", async () => {
    const { client, calls } = makeFake({
      fee_settlements: [{ data: [{ id: "set1" }], error: null }],
      fee_settlement_lines: [{ data: [{ id: "fl1" }, { id: "fl2" }], error: null }],
    });

    const [res] = await persistSettlements([plan], client);
    expect(res).toEqual({
      subscriberId: "subA",
      cycleClose: "2026-08-15",
      settlementId: "set1",
      created: true,
      linesInserted: 2,
    });

    // Settlement payload + conflict target.
    const setUpsert = calls.find((c) => c.table === "fee_settlements" && c.method === "upsert")!;
    expect(setUpsert.args[0]).toMatchObject({
      subscriber_id: "subA",
      cycle_close: "2026-08-15",
      total_fee_cents: 444,
      currency: "USD",
      status: "pending",
      line_count: 2,
      stripe_idempotency_key: "settle_subA_2026-08-15",
    });
    expect(setUpsert.args[1]).toMatchObject({
      onConflict: "subscriber_id,cycle_close",
      ignoreDuplicates: true,
    });

    // Lines carry the settlement id + fee cents, conflict target ledger_row_id.
    const lineUpsert = calls.find((c) => c.table === "fee_settlement_lines" && c.method === "upsert")!;
    expect(lineUpsert.args[0]).toEqual([
      { settlement_id: "set1", ledger_row_id: "l1", fee_cents: 333 },
      { settlement_id: "set1", ledger_row_id: "l2", fee_cents: 111 },
    ]);
    expect(lineUpsert.args[1]).toMatchObject({ onConflict: "ledger_row_id", ignoreDuplicates: true });
  });

  it("re-run: settlement already exists (conflict) → no duplicate, no lines touched", async () => {
    const { client, calls } = makeFake({
      // upsert ignored the duplicate (returns []), then the existing-row lookup.
      fee_settlements: [
        { data: [], error: null },
        { data: { id: "set1" }, error: null },
      ],
    });

    const [res] = await persistSettlements([plan], client);
    expect(res).toEqual({
      subscriberId: "subA",
      cycleClose: "2026-08-15",
      settlementId: "set1",
      created: false,
      linesInserted: 0,
    });
    // Idempotent: lines are never written when the settlement already existed.
    expect(calls.some((c) => c.table === "fee_settlement_lines")).toBe(false);
  });

  it("processes multiple billable plans independently", async () => {
    const planB: SettlementPlan = {
      subscriberId: "subB",
      cycleClose: "2026-08-15",
      totalFeeCents: 500,
      lineCount: 1,
      lines: [{ ledgerRowId: "l9", feeCents: 500 }],
      billable: true,
    };
    const { client } = makeFake({
      fee_settlements: [
        { data: [{ id: "set1" }], error: null },
        { data: [{ id: "set2" }], error: null },
      ],
      fee_settlement_lines: [
        { data: [{ id: "fl1" }, { id: "fl2" }], error: null },
        { data: [{ id: "fl3" }], error: null },
      ],
    });
    const results = await persistSettlements([plan, planB], client);
    expect(results.map((r) => r.settlementId)).toEqual(["set1", "set2"]);
    expect(results.map((r) => r.linesInserted)).toEqual([2, 1]);
  });
});

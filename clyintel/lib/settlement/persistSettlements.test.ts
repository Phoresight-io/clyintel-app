import { describe, it, expect } from "vitest";
import { persistSettlements, settlementIdempotencyKey } from "./persistSettlements";
import type { SettlementPlan } from "./computeSettlements";

type RpcResult = { data: unknown; error: unknown };

/** Stub whose .rpc(fn, args) records the call and returns the next queued result. */
function makeRpcFake(queue: RpcResult[]) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return Promise.resolve(queue.shift() ?? { data: null, error: null });
  };
  return { client: { rpc } as never, calls };
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

describe("persistSettlements (atomic RPC)", () => {
  it("new settlement: calls persist_fee_settlement with the full row + all lines in one call", async () => {
    const { client, calls } = makeRpcFake([
      { data: [{ settlement_id: "set1", created: true }], error: null },
    ]);

    const [res] = await persistSettlements([plan], client);
    expect(res).toEqual({
      subscriberId: "subA",
      cycleClose: "2026-08-15",
      settlementId: "set1",
      created: true,
      linesInserted: 2,
    });

    // Exactly one RPC — settlement + lines land together (atomic), not two writes.
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("persist_fee_settlement");
    expect(calls[0].args).toEqual({
      p_subscriber_id: "subA",
      p_cycle_close: "2026-08-15",
      p_total_fee_cents: 444,
      p_currency: "USD",
      p_line_count: 2,
      p_stripe_idempotency_key: "settle_subA_2026-08-15",
      p_lines: [
        { ledger_row_id: "l1", fee_cents: 333 },
        { ledger_row_id: "l2", fee_cents: 111 },
      ],
    });
  });

  it("re-run: RPC reports created=false → no duplicate, linesInserted 0", async () => {
    const { client } = makeRpcFake([
      { data: [{ settlement_id: "set1", created: false }], error: null },
    ]);
    const [res] = await persistSettlements([plan], client);
    expect(res).toMatchObject({ settlementId: "set1", created: false, linesInserted: 0 });
  });

  it("throws if the RPC errors (surfaced to the caller, nothing swallowed)", async () => {
    const { client } = makeRpcFake([{ data: null, error: { message: "boom" } }]);
    await expect(persistSettlements([plan], client)).rejects.toThrow(/persist_fee_settlement RPC failed/);
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
    const { client, calls } = makeRpcFake([
      { data: [{ settlement_id: "set1", created: true }], error: null },
      { data: [{ settlement_id: "set2", created: true }], error: null },
    ]);
    const results = await persistSettlements([plan, planB], client);
    expect(results.map((r) => r.settlementId)).toEqual(["set1", "set2"]);
    expect(results.map((r) => r.linesInserted)).toEqual([2, 1]);
    expect(calls).toHaveLength(2);
  });
});

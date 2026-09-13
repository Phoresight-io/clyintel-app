import { describe, it, expect } from "vitest";
import { selectEligibleLedgerRows } from "./selectEligibleLedgerRows";

type Result = { data: unknown; error: unknown };

/**
 * Recording Supabase stub. from(table) returns a chainable, thenable builder;
 * chain methods record their call and return the builder; awaiting yields the
 * next queued Result for that table (FIFO). Filters don't actually run — canned
 * results stand in for what the DB would return once its SQL filters applied —
 * so behavioural assertions test the in-memory join, and `calls` lets us assert
 * which SQL filters were requested.
 */
function makeFake(queues: Record<string, Result[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lte", "not", "in", "upsert", "single", "maybeSingle", "order", "range"]) {
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

const BOUNDARY = "2026-08-15";

describe("selectEligibleLedgerRows", () => {
  it("keeps only active-subscriber, unlinked rows accrued on/before the boundary", async () => {
    const { client } = makeFake({
      // Only subA is active/non-test (the DB applied subscription_status/test_user).
      subscribers: [{ data: [{ id: "subA" }], error: null }],
      // l2 is already linked to a settlement.
      fee_settlement_lines: [{ data: [{ ledger_row_id: "l2" }], error: null }],
      rev_share_ledger: [
        {
          data: [
            { id: "l1", subscriber_id: "subA", fee_amount: 3.33, cycle_close: "2026-07-15", source: "qbo" },
            { id: "l2", subscriber_id: "subA", fee_amount: 1.0, cycle_close: "2026-07-15", source: "stripe_recovery" },
            { id: "l3", subscriber_id: "subB", fee_amount: 9.0, cycle_close: "2026-07-15", source: "qbo" },
          ],
          error: null,
        },
      ],
    });

    const rows = await selectEligibleLedgerRows({ boundary: BOUNDARY }, client);

    // l2 dropped (linked), l3 dropped (subB not active). Only l1 survives.
    expect(rows).toEqual([
      { id: "l1", subscriberId: "subA", feeAmount: 3.33, cycleClose: "2026-07-15", source: "qbo" },
    ]);
  });

  it("is source-agnostic (qbo + stripe_recovery both eligible)", async () => {
    const { client } = makeFake({
      subscribers: [{ data: [{ id: "subA" }], error: null }],
      fee_settlement_lines: [{ data: [], error: null }],
      rev_share_ledger: [
        {
          data: [
            { id: "l1", subscriber_id: "subA", fee_amount: 1.0, cycle_close: "2026-08-01", source: "qbo" },
            { id: "l2", subscriber_id: "subA", fee_amount: 2.0, cycle_close: "2026-08-01", source: "stripe_recovery" },
          ],
          error: null,
        },
      ],
    });
    const rows = await selectEligibleLedgerRows({ boundary: BOUNDARY }, client);
    expect(rows.map((r) => r.source).sort()).toEqual(["qbo", "stripe_recovery"]);
  });

  it("live (default): filters subscribers by test_user = false and ledger by cycle_close <= boundary", async () => {
    const { client, calls } = makeFake({
      subscribers: [{ data: [{ id: "subA" }], error: null }],
      fee_settlement_lines: [{ data: [], error: null }],
      rev_share_ledger: [{ data: [], error: null }],
    });
    await selectEligibleLedgerRows({ boundary: BOUNDARY }, client);

    expect(
      calls.some((c) => c.table === "subscribers" && c.method === "eq" && c.args[0] === "test_user" && c.args[1] === false),
    ).toBe(true);
    expect(
      calls.some((c) => c.table === "subscribers" && c.method === "eq" && c.args[0] === "subscription_status" && c.args[1] === "active"),
    ).toBe(true);
    expect(
      calls.some((c) => c.table === "rev_share_ledger" && c.method === "lte" && c.args[0] === "cycle_close" && c.args[1] === BOUNDARY),
    ).toBe(true);
  });

  it("PREVIEW (includeTestUsers): does NOT apply the test_user filter", async () => {
    const { client, calls } = makeFake({
      subscribers: [{ data: [{ id: "subTest" }], error: null }],
      fee_settlement_lines: [{ data: [], error: null }],
      rev_share_ledger: [
        { data: [{ id: "l1", subscriber_id: "subTest", fee_amount: 1.0, cycle_close: "2026-08-01", source: "qbo" }], error: null },
      ],
    });
    const rows = await selectEligibleLedgerRows({ boundary: BOUNDARY, includeTestUsers: true }, client);

    expect(calls.some((c) => c.table === "subscribers" && c.method === "eq" && c.args[0] === "test_user")).toBe(false);
    expect(rows).toHaveLength(1); // the test-user subscriber's row is included
  });

  it("no active subscribers → returns [] without reading the ledger", async () => {
    const { client, calls } = makeFake({
      subscribers: [{ data: [], error: null }],
    });
    const rows = await selectEligibleLedgerRows({ boundary: BOUNDARY }, client);
    expect(rows).toEqual([]);
    expect(calls.some((c) => c.table === "rev_share_ledger")).toBe(false);
  });
});

/**
 * Pagination-aware stub: from(table) slices datasets[table] by the requested
 * .range(from, to) window, so a backing set larger than one PostgREST page (1000)
 * is only fully read if the caller pages through it. Records each range window so
 * we can assert multiple pages were fetched.
 */
function makePagingFake(datasets: Record<string, unknown[]>) {
  const rangeCalls: Record<string, [number, number][]> = {};
  const from = (table: string) => {
    let rFrom = 0;
    let rTo = Number.MAX_SAFE_INTEGER;
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lte", "not", "in", "order"]) {
      builder[m] = () => builder;
    }
    builder.range = (f: number, t: number) => {
      rFrom = f;
      rTo = t;
      (rangeCalls[table] ??= []).push([f, t]);
      return builder;
    };
    builder.then = (onF: (v: { data: unknown[]; error: null }) => unknown, onR?: (e: unknown) => unknown) => {
      const ds = datasets[table] ?? [];
      const slice = ds.slice(rFrom, rTo + 1); // inclusive upper bound, like PostgREST
      return Promise.resolve({ data: slice, error: null }).then(onF, onR);
    };
    return builder;
  };
  return { client: { from } as never, rangeCalls };
}

describe("selectEligibleLedgerRows — pagination (row-cap safety)", () => {
  it("reads ALL rows past the 1000-row cap for BOTH the ledger and the linked set", async () => {
    // 2500 eligible-shaped ledger rows for one active subscriber; 1500 of them
    // already linked. If either read stopped at one page (1000), the result would
    // be wrong: a truncated ledger read → < 1000 kept; a truncated linked read →
    // stale exclusions leaving linked rows in. Correct answer: led-1500..led-2499.
    const LEDGER = 2500;
    const LINKED = 1500;
    const ledgerRows = Array.from({ length: LEDGER }, (_, i) => ({
      id: `led-${i}`,
      subscriber_id: "subA",
      fee_amount: 1,
      cycle_close: "2026-07-15",
      source: "qbo",
    }));
    const linkedRows = Array.from({ length: LINKED }, (_, i) => ({ ledger_row_id: `led-${i}` }));

    const { client, rangeCalls } = makePagingFake({
      subscribers: [{ id: "subA" }],
      fee_settlement_lines: linkedRows,
      rev_share_ledger: ledgerRows,
    });

    const rows = await selectEligibleLedgerRows({ boundary: BOUNDARY }, client);

    // Exactly the unlinked tail, none dropped by the cap.
    expect(rows).toHaveLength(LEDGER - LINKED); // 1000
    expect(rows.every((r) => !r.id.startsWith("led-") || Number(r.id.slice(4)) >= LINKED)).toBe(true);
    expect(rows[0].id).toBe(`led-${LINKED}`);
    expect(rows[rows.length - 1].id).toBe(`led-${LEDGER - 1}`);

    // Proof that paging actually happened (multiple windows per big read).
    expect(rangeCalls["rev_share_ledger"].length).toBe(3); // 1000 + 1000 + 500
    expect(rangeCalls["fee_settlement_lines"].length).toBe(2); // 1000 + 500
  });
});

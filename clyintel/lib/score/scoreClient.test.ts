import { describe, it, expect, vi } from "vitest";
import { scoreClient, makeScorePort, SCORE_UPSERT_CONFLICT, type ScorePort } from "./scoreClient";
import type { ScoreInputs } from "./computeClientScore";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AS_OF = new Date("2026-09-25T12:00:00Z");

const inputs: ScoreInputs = {
  asOf: AS_OF,
  invoices: [
    { id: "i1", status: "overdue", due_date: "2026-09-01", issue_date: "2026-08-01", created_at: "2026-08-01T00:00:00Z", amount_cents: 10000, amount_outstanding_cents: 10000 },
  ],
  paidTimings: [],
};

function fakePort(overrides: Partial<ScorePort> = {}) {
  const port = {
    isClientOwned: vi.fn(async () => true),
    loadInputs: vi.fn(async () => inputs),
    upsertScore: vi.fn(async () => {}),
    ...overrides,
  };
  return port;
}

describe("scoreClient — ownership gate", () => {
  it("unowned client → 404, no load, no write", async () => {
    const port = fakePort({ isClientOwned: vi.fn(async () => false) });
    const res = await scoreClient({ clientId: CLIENT, subscriberId: USER, mode: "write", asOf: AS_OF }, port);
    expect(res.status).toBe(404);
    expect(port.loadInputs).not.toHaveBeenCalled();
    expect(port.upsertScore).not.toHaveBeenCalled();
  });

  it("non-UUID id → 404 without hitting the port", async () => {
    const port = fakePort();
    const res = await scoreClient({ clientId: "123", subscriberId: USER, mode: "write", asOf: AS_OF }, port);
    expect(res.status).toBe(404);
    expect(port.isClientOwned).not.toHaveBeenCalled();
    expect(port.upsertScore).not.toHaveBeenCalled();
  });
});

describe("scoreClient — dry run (GET)", () => {
  it("returns the full ScoreResult and writes nothing", async () => {
    const port = fakePort();
    const res = await scoreClient({ clientId: CLIENT, subscriberId: USER, mode: "dry_run", asOf: AS_OF }, port);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "scored", written: false, score_month: "2026-09" });
    expect(res.body.score_summary).toBeInstanceOf(Array);
    expect(port.upsertScore).not.toHaveBeenCalled();
  });
});

describe("scoreClient — write (POST)", () => {
  it("upserts one row with client_id + subscriber_id, no ai_* or counted_toward_limit", async () => {
    const port = fakePort();
    const res = await scoreClient({ clientId: CLIENT, subscriberId: USER, mode: "write", asOf: AS_OF }, port);
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(true);
    expect(port.upsertScore).toHaveBeenCalledTimes(1);
    const row = vi.mocked(port.upsertScore).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(row.client_id).toBe(CLIENT);
    expect(row.subscriber_id).toBe(USER);
    expect(row.score_month).toBe("2026-09");
    expect(row).not.toHaveProperty("kind");
    expect(row).not.toHaveProperty("ai_model");
    expect(row).not.toHaveProperty("ai_recommendation");
    expect(row).not.toHaveProperty("counted_toward_limit");
  });

  it("insufficient_data → 422, no write", async () => {
    const port = fakePort({ loadInputs: vi.fn(async () => ({ ...inputs, invoices: [] })) });
    const res = await scoreClient({ clientId: CLIENT, subscriberId: USER, mode: "write", asOf: AS_OF }, port);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ kind: "insufficient_data", written: false });
    expect(port.upsertScore).not.toHaveBeenCalled();
  });
});

describe("makeScorePort — service-role wiring", () => {
  function fakeDb() {
    const calls: { table: string; op: string; args: unknown[] }[] = [];
    const builder = (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "lt", "order", "limit"]) {
        b[m] = (...args: unknown[]) => {
          calls.push({ table, op: m, args });
          return b;
        };
      }
      b.maybeSingle = async () => ({ data: table === "clients" ? { id: CLIENT } : null, error: null });
      b.upsert = async (...args: unknown[]) => {
        calls.push({ table, op: "upsert", args });
        return { error: null };
      };
      return b;
    };
    return { db: { from: (t: string) => builder(t) } as never, calls };
  }

  it("ownership SELECT is scoped by id AND subscriber_id", async () => {
    const { db, calls } = fakeDb();
    expect(await makeScorePort(db, USER).isClientOwned(CLIENT)).toBe(true);
    const eqs = calls.filter((c) => c.table === "clients" && c.op === "eq").map((c) => c.args);
    expect(eqs).toEqual([["id", CLIENT], ["subscriber_id", USER]]);
  });

  it("upsert targets ptr_scores with onConflict client_id,score_month", async () => {
    const { db, calls } = fakeDb();
    const row = { client_id: CLIENT, subscriber_id: USER, score_month: "2026-09" } as never;
    await makeScorePort(db, USER).upsertScore(row);
    const up = calls.find((c) => c.op === "upsert")!;
    expect(up.table).toBe("ptr_scores");
    expect(SCORE_UPSERT_CONFLICT).toBe("client_id,score_month");
    expect(up.args[1]).toEqual({ onConflict: "client_id,score_month" });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureCurrentScoreCore, type EnsureScoreDeps } from "./ensureCurrentScore";
import type { ScorePort } from "./scoreClient";
import type { ScoreInputs } from "./computeClientScore";
import type { PtrScorePair } from "../adapters";
import { SCORER_VERSION } from "./scoreBands";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-25T12:00:00Z");

const inputs: ScoreInputs = {
  asOf: NOW,
  invoices: [
    { id: "i1", status: "sent", due_date: "2026-10-15", issue_date: null, created_at: "2026-09-01T00:00:00Z", amount_cents: 1000, amount_outstanding_cents: 1000 },
  ],
  paidTimings: [],
};

const row = (scoreDate: string, opts: { version?: string | null; score?: number } = {}) =>
  ({
    score_date: scoreDate,
    score_month: scoreDate.slice(0, 7),
    composite_score: opts.score ?? 80,
    inputs: opts.version === null ? { provisional: false } : { version: opts.version ?? SCORER_VERSION },
  }) as unknown as NonNullable<PtrScorePair["latest"]>;

function makeDeps(opts: { before: PtrScorePair; after?: PtrScorePair; port?: Partial<ScorePort> }) {
  const readScores = vi.fn<() => Promise<PtrScorePair>>();
  readScores.mockResolvedValueOnce(opts.before).mockResolvedValue(opts.after ?? opts.before);
  const port = {
    isClientOwned: vi.fn(async () => true),
    loadInputs: vi.fn(async () => inputs),
    upsertScore: vi.fn(async () => {}),
    ...opts.port,
  };
  const deps: EnsureScoreDeps = { readScores, port, now: NOW };
  return { deps, port, readScores };
}

const nonDraft = [{ status: "sent" as const }];
const args = { userId: USER, clientId: CLIENT, invoices: nonDraft };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ensureCurrentScoreCore", () => {
  it("no row → writes and returns the fresh rows", async () => {
    const fresh = { latest: row("2026-09-25"), prior: null };
    const { deps, port } = makeDeps({ before: { latest: null, prior: null }, after: fresh });
    expect(await ensureCurrentScoreCore(args, deps)).toBe(fresh);
    expect(port.upsertScore).toHaveBeenCalledTimes(1);
    expect(vi.mocked(port.upsertScore).mock.calls[0][0]).toMatchObject({ client_id: CLIENT, subscriber_id: USER, score_month: "2026-09" });
  });

  it("score_date = yesterday, same month → writes the same monthly row", async () => {
    const yesterday = { latest: row("2026-09-24"), prior: null };
    const fresh = { latest: row("2026-09-25"), prior: null };
    const { deps, port } = makeDeps({ before: yesterday, after: fresh });
    expect(await ensureCurrentScoreCore(args, deps)).toBe(fresh);
    expect(port.upsertScore).toHaveBeenCalledTimes(1);
    // Same (client_id, score_month) key → the upsert overwrites September's row.
    expect(vi.mocked(port.upsertScore).mock.calls[0][0]).toMatchObject({
      client_id: CLIENT,
      score_month: "2026-09",
      score_date: "2026-09-25",
    });
  });

  it("version missing → writes", async () => {
    const { deps, port } = makeDeps({ before: { latest: row("2026-09-25", { version: null }), prior: null } });
    await ensureCurrentScoreCore(args, deps);
    expect(port.upsertScore).toHaveBeenCalledTimes(1);
  });

  it("version differs → writes", async () => {
    const { deps, port } = makeDeps({ before: { latest: row("2026-09-25", { version: "client-score-v1" }), prior: null } });
    await ensureCurrentScoreCore(args, deps);
    expect(port.upsertScore).toHaveBeenCalledTimes(1);
  });

  it("score_date check uses the UTC date, not the local time", async () => {
    // 2026-09-25T23:30Z is still Sept 25 in UTC → a row scored that day is fresh.
    const current = { latest: row("2026-09-25"), prior: null };
    const { deps, port } = makeDeps({ before: current });
    deps.now = new Date("2026-09-25T23:30:00Z");
    await ensureCurrentScoreCore(args, deps);
    expect(port.upsertScore).not.toHaveBeenCalled();
  });

  it("stale month → writes", async () => {
    const stale = { latest: row("2026-08-31"), prior: null };
    const fresh = { latest: row("2026-09-25"), prior: row("2026-08-31") };
    const { deps, port } = makeDeps({ before: stale, after: fresh });
    expect(await ensureCurrentScoreCore(args, deps)).toBe(fresh);
    expect(port.upsertScore).toHaveBeenCalledTimes(1);
  });

  it("score_date = today and version matches → no write, returns existing", async () => {
    const current = { latest: row("2026-09-25"), prior: null };
    const { deps, port, readScores } = makeDeps({ before: current });
    expect(await ensureCurrentScoreCore(args, deps)).toBe(current);
    expect(port.isClientOwned).not.toHaveBeenCalled();
    expect(port.upsertScore).not.toHaveBeenCalled();
    expect(readScores).toHaveBeenCalledTimes(1);
  });

  it("no non-draft invoices → no scoring attempt", async () => {
    const { deps, port } = makeDeps({ before: { latest: null, prior: null } });
    const res = await ensureCurrentScoreCore({ ...args, invoices: [{ status: "draft" }] }, deps);
    expect(res).toEqual({ latest: null, prior: null });
    expect(port.loadInputs).not.toHaveBeenCalled();
    expect(port.upsertScore).not.toHaveBeenCalled();
  });

  it("insufficient_data → no write, returns existing (null)", async () => {
    const { deps, port } = makeDeps({
      before: { latest: null, prior: null },
      port: { loadInputs: vi.fn(async () => ({ ...inputs, invoices: [] })) },
    });
    expect(await ensureCurrentScoreCore(args, deps)).toEqual({ latest: null, prior: null });
    expect(port.upsertScore).not.toHaveBeenCalled();
  });

  it("scorer throws (port) → returns existing, never throws", async () => {
    const stale = { latest: row("2026-08-31"), prior: null };
    const { deps } = makeDeps({
      before: stale,
      port: { upsertScore: vi.fn(async () => { throw new Error("db down"); }) },
    });
    await expect(ensureCurrentScoreCore(args, deps)).resolves.toBe(stale);
    expect(console.error).toHaveBeenCalled();
  });

  it("readScores throws → returns empty pair, never throws", async () => {
    const deps: EnsureScoreDeps = {
      readScores: vi.fn(async () => { throw new Error("boom"); }),
      port: { isClientOwned: vi.fn(), loadInputs: vi.fn(), upsertScore: vi.fn() },
      now: NOW,
    };
    await expect(ensureCurrentScoreCore(args, deps)).resolves.toEqual({ latest: null, prior: null });
  });
});

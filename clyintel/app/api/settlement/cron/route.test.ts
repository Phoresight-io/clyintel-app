import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the collaborators — the route test is about auth + wiring + summary shape,
// not the sweep/charge internals (covered by their own suites). No real DB/Stripe.
vi.mock("@/lib/supabase", () => ({ getSupabase: () => ({}) }));
vi.mock("@/lib/settlement/runSweep", () => ({ runSettlementSweep: vi.fn() }));
vi.mock("@/lib/settlement/chargeSettlement", () => ({ drainSettlements: vi.fn() }));

import { GET } from "./route";
import { runSettlementSweep } from "@/lib/settlement/runSweep";
import { drainSettlements } from "@/lib/settlement/chargeSettlement";

// Minimal request stub — the route only reads the Authorization header.
const req = (auth?: string) =>
  ({ headers: { get: (k: string) => (k.toLowerCase() === "authorization" && auth ? auth : null) } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("settlement cron route — auth", () => {
  it("500 when SETTLEMENT_CRON_SECRET is not configured (never runs unguarded)", async () => {
    // no env set
    const res = await GET(req("Bearer whatever"));
    expect(res.status).toBe(500);
    expect(runSettlementSweep).not.toHaveBeenCalled();
    expect(drainSettlements).not.toHaveBeenCalled();
  });

  it("401 on a wrong/missing secret — no work done", async () => {
    vi.stubEnv("SETTLEMENT_CRON_SECRET", "right");
    const res = await GET(req("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(runSettlementSweep).not.toHaveBeenCalled();
    expect(drainSettlements).not.toHaveBeenCalled();

    const res2 = await GET(req(undefined)); // no header
    expect(res2.status).toBe(401);
  });
});

describe("settlement cron route — run + summary", () => {
  it("correct secret → runs sweep then charge, returns a compact summary", async () => {
    vi.stubEnv("SETTLEMENT_CRON_SECRET", "right");
    vi.mocked(runSettlementSweep).mockResolvedValue({
      boundary: "2026-08-15",
      dryRun: false,
      sweepEnabled: true,
      wrote: true,
      minChargeCents: 50,
      eligibleRowCount: 3,
      billable: [{ subscriberId: "a", totalFeeCents: 100, lineCount: 1 }, { subscriberId: "b", totalFeeCents: 200, lineCount: 2 }],
      carried: [{ subscriberId: "c", totalFeeCents: 10, lineCount: 1 }],
      persisted: [{ subscriberId: "a", cycleClose: "2026-08-15", settlementId: "s1", created: true, linesInserted: 1 }],
    } as never);
    vi.mocked(drainSettlements).mockResolvedValue({
      dryRun: false,
      charging: true,
      chargingEnabled: true,
      liveEnv: true,
      candidates: 2,
      charged: 1,
      failed: 1,
      skipped: 0,
      outcomes: [],
    } as never);

    const res = await GET(req("Bearer right"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      boundary: "2026-08-15",
      persist: { sweepEnabled: true, wrote: true, eligibleRows: 3, billable: 2, carried: 1, persisted: 1 },
      charge: { chargingEnabled: true, liveEnv: true, charging: true, candidates: 2, charged: 1, failed: 1, skipped: 0 },
    });

    // Sweep runs with dryRun=false and an explicit boundary; charge with dryRun=false.
    expect(vi.mocked(runSettlementSweep).mock.calls[0][0]).toMatchObject({ dryRun: false });
    expect(typeof (vi.mocked(runSettlementSweep).mock.calls[0][0] as { boundary?: unknown }).boundary).toBe("string");
    expect(vi.mocked(drainSettlements).mock.calls[0][0]).toMatchObject({ dryRun: false });
  });
});

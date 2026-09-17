import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock refundSettlement — this suite tests the ENDPOINT (auth, validation,
// forwarding, response), NOT the execution (covered by refundSettlement.test.ts).
vi.mock("@/lib/settlement/refundSettlement", () => ({ refundSettlement: vi.fn() }));

import { POST, GET } from "./route";
import { refundSettlement } from "@/lib/settlement/refundSettlement";

const SETTLEMENT_ID = "11111111-1111-4111-8111-111111111111";

// Minimal request stub — the route reads the Authorization header and req.json().
const req = (opts: { auth?: string; body?: unknown; badJson?: boolean }) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? (opts.auth ?? null) : null) },
    json: async () => {
      if (opts.badJson) throw new Error("bad json");
      return opts.body;
    },
  }) as never;

const okOutcome = { ok: true, action: "dry_run", settlementId: SETTLEMENT_ID, mechanism: "refund", reason: "gated" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("ops refund endpoint — auth (before any work)", () => {
  it("missing SETTLEMENT_REFUNDS_OPS_SECRET → 500, refundSettlement NOT called", async () => {
    const res = await POST(req({ auth: "Bearer whatever", body: { settlementId: SETTLEMENT_ID, reason: "x", actor: "ops" } }));
    expect(res.status).toBe(500);
    expect(refundSettlement).not.toHaveBeenCalled();
  });

  it("wrong bearer → 401; missing header → 401; refundSettlement NOT called", async () => {
    vi.stubEnv("SETTLEMENT_REFUNDS_OPS_SECRET", "right");
    const res = await POST(req({ auth: "Bearer wrong", body: { settlementId: SETTLEMENT_ID, reason: "x", actor: "ops" } }));
    expect(res.status).toBe(401);
    const res2 = await POST(req({ body: { settlementId: SETTLEMENT_ID, reason: "x", actor: "ops" } }));
    expect(res2.status).toBe(401);
    expect(refundSettlement).not.toHaveBeenCalled();
  });
});

describe("ops refund endpoint — method", () => {
  it("non-POST → 405", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});

describe("ops refund endpoint — input validation (400, no execution)", () => {
  const good = { settlementId: SETTLEMENT_ID, reason: "customer goodwill", actor: "ops:charles" };
  const cases: { name: string; body: unknown }[] = [
    { name: "missing settlementId", body: { reason: "x", actor: "ops" } },
    { name: "blank settlementId", body: { ...good, settlementId: "  " } },
    { name: "non-uuid settlementId", body: { ...good, settlementId: "not-a-uuid" } },
    { name: "blank reason", body: { ...good, reason: "   " } },
    { name: "missing reason", body: { settlementId: SETTLEMENT_ID, actor: "ops" } },
    { name: "reason too long", body: { ...good, reason: "x".repeat(1001) } },
    { name: "blank actor", body: { ...good, actor: "" } },
    { name: "actor too long", body: { ...good, actor: "a".repeat(201) } },
    { name: "non-boolean dryRun", body: { ...good, dryRun: "yes" } },
  ];
  for (const c of cases) {
    it(`${c.name} → 400, refundSettlement NOT called`, async () => {
      vi.stubEnv("SETTLEMENT_REFUNDS_OPS_SECRET", "right");
      const res = await POST(req({ auth: "Bearer right", body: c.body }));
      expect(res.status).toBe(400);
      expect(refundSettlement).not.toHaveBeenCalled();
    });
  }

  it("invalid JSON body → 400, refundSettlement NOT called", async () => {
    vi.stubEnv("SETTLEMENT_REFUNDS_OPS_SECRET", "right");
    const res = await POST(req({ auth: "Bearer right", badJson: true }));
    expect(res.status).toBe(400);
    expect(refundSettlement).not.toHaveBeenCalled();
  });
});

describe("ops refund endpoint — forwarding + response", () => {
  it("dryRun omitted → refundSettlement called with dryRun:true and exact {reason, actor}; 200 with outcome", async () => {
    vi.stubEnv("SETTLEMENT_REFUNDS_OPS_SECRET", "right");
    vi.mocked(refundSettlement).mockResolvedValue(okOutcome as never);

    const res = await POST(req({ auth: "Bearer right", body: { settlementId: SETTLEMENT_ID, reason: "customer goodwill", actor: "ops:charles" } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okOutcome);
    expect(vi.mocked(refundSettlement)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refundSettlement).mock.calls[0][0]).toBe(SETTLEMENT_ID);
    // Exact options — dryRun defaults true; NO liveChargesAllowed injected (real gate).
    expect(vi.mocked(refundSettlement).mock.calls[0][1]).toEqual({
      reason: "customer goodwill",
      actor: "ops:charles",
      dryRun: true,
    });
  });

  it("dryRun:false → forwarded as false, still NO liveChargesAllowed override (real gate fails closed)", async () => {
    vi.stubEnv("SETTLEMENT_REFUNDS_OPS_SECRET", "right");
    vi.mocked(refundSettlement).mockResolvedValue({ ...okOutcome, reason: "gated" } as never);

    const res = await POST(req({ auth: "Bearer right", body: { settlementId: SETTLEMENT_ID, reason: "r", actor: "ops", dryRun: false } }));

    expect(res.status).toBe(200);
    expect(vi.mocked(refundSettlement).mock.calls[0][1]).toEqual({ reason: "r", actor: "ops", dryRun: false });
    // no liveChargesAllowed / stripe / supabase injected by the endpoint
    expect(Object.keys(vi.mocked(refundSettlement).mock.calls[0][1])).toEqual(["reason", "actor", "dryRun"]);
  });

  it("refundSettlement rejection (ok:false) → 200 with the outcome verbatim (no HTTP error mapping)", async () => {
    vi.stubEnv("SETTLEMENT_REFUNDS_OPS_SECRET", "right");
    const rejection = { ok: false, action: "rejected", settlementId: SETTLEMENT_ID, reason: "nothing_to_reverse:paid" };
    vi.mocked(refundSettlement).mockResolvedValue(rejection as never);

    const res = await POST(req({ auth: "Bearer right", body: { settlementId: SETTLEMENT_ID, reason: "r", actor: "ops" } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rejection);
  });
});

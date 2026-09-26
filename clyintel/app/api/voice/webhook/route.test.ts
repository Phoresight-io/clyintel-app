import { describe, it, expect, vi, beforeEach } from "vitest";

// Route-level: the end-of-call patch (paymentCommitted:false is persisted as
// false), auth, and — since the post-call email trigger (#140) was removed — that
// no webhook event ever reaches the email send or the handoff claim.
const updates: { table: string; patch: Record<string, unknown> }[] = [];
const inserts: { table: string; row: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let pendingPatch: Record<string, unknown> | null = null;
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: table === "voice_calls" ? { id: "vc-1" } : null, error: null });
      b.insert = async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { error: null };
      };
      b.update = (patch: Record<string, unknown>) => {
        pendingPatch = patch;
        updates.push({ table, patch });
        return b;
      };
      b.then = (resolve: (v: unknown) => void) =>
        resolve({ data: pendingPatch ? [{ id: "vc-1" }] : [], error: null });
      return b;
    },
  }),
}));

// Tripwire: the send path must never be reached from this route.
const sendEmailStep = vi.fn();
vi.mock("@/lib/outreach/sendEmailStep", () => ({
  sendEmailStep: (...a: unknown[]) => sendEmailStep(...a),
}));

import { POST } from "./route";

const SECRET = "vapi-secret";
function req(message: Record<string, unknown>) {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "x-vapi-secret" ? SECRET : null) },
    text: async () => JSON.stringify({ message }),
  } as never;
}
const eocr = (structuredData?: Record<string, unknown>) => ({
  type: "end-of-call-report",
  endedReason: "customer-ended-call",
  call: { id: "vapi-1", metadata: { voiceCallId: "vc-1" } },
  analysis: structuredData ? { structuredData } : {},
});

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  sendEmailStep.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("voice/webhook — end-of-call patch, auth, no post-call email", () => {
  it("regression: sendPaymentLink:true + VOICE_HANDOFF_EMAIL_MODE=live → no send, no communications insert, no handoff claim", async () => {
    vi.stubEnv("VOICE_HANDOFF_EMAIL_MODE", "live");
    const res = await POST(req(eocr({ sendPaymentLink: true, paymentCommitted: true })));
    expect(res.status).toBe(200);
    // The end-of-call patch still lands…
    const patch = updates.find((u) => u.table === "voice_calls")!.patch;
    expect(patch).toMatchObject({ status: "ended", outcome: "connected" });
    // …but the post-call email path is gone.
    expect(sendEmailStep).not.toHaveBeenCalled();
    expect(inserts.filter((i) => i.table === "communications")).toHaveLength(0);
    expect(inserts.filter((i) => i.table === "recovery_attempts")).toHaveLength(0);
    expect(updates.some((u) => "handoff_email_status" in u.patch)).toBe(false);
    expect(updates.filter((u) => u.table === "voice_calls")).toHaveLength(1);
  });

  it("status-update applies the status only, never touches the send path", async () => {
    await POST(req({ type: "status-update", status: "in-progress", call: { id: "vapi-1", metadata: { voiceCallId: "vc-1" } } }));
    expect(updates.find((u) => u.table === "voice_calls")!.patch).toEqual({ status: "in-progress" });
    expect(sendEmailStep).not.toHaveBeenCalled();
  });

  it("paymentCommitted:false → payment_committed false, committed_* untouched (bug-fix regression)", async () => {
    await POST(req(eocr({ paymentCommitted: false, committedAmount: 100, committedDate: "2026-10-01" })));
    const patch = updates.find((u) => u.table === "voice_calls")!.patch;
    expect(patch.payment_committed).toBe(false);
    expect(patch).not.toHaveProperty("committed_amount");
    expect(patch).not.toHaveProperty("committed_date");
  });

  it("paymentCommitted:true → payment_committed true with committed_*", async () => {
    await POST(req(eocr({ paymentCommitted: true, committedAmount: 100, committedDate: "2026-10-01" })));
    const patch = updates.find((u) => u.table === "voice_calls")!.patch;
    expect(patch).toMatchObject({ payment_committed: true, committed_amount: 100, committed_date: "2026-10-01" });
  });

  it("wrong secret → 401, nothing written", async () => {
    const bad = { headers: { get: () => "nope" }, text: async () => "{}" } as never;
    expect((await POST(bad)).status).toBe(401);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

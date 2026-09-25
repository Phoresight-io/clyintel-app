import { describe, it, expect, vi, beforeEach } from "vitest";

// Route-level: the handoff is isolated (a throw never changes the 200 or the
// end-of-call patch), and paymentCommitted:false is persisted as false.
const updates: { table: string; patch: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let pendingPatch: Record<string, unknown> | null = null;
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: table === "voice_calls" ? { id: "vc-1" } : null, error: null });
      b.insert = async () => ({ error: null });
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

const handoff = vi.fn();
vi.mock("@/lib/voice/handoffEmail", async (orig) => {
  const real = await orig<typeof import("@/lib/voice/handoffEmail")>();
  return { ...real, maybeSendVoiceHandoffEmail: (...a: unknown[]) => handoff(...a), createHandoffPort: () => ({}) };
});

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
  handoff.mockReset();
  vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("voice/webhook — handoff isolation + payment_committed fix", () => {
  it("handoff throwing does not change the 200 or the end-of-call patch", async () => {
    handoff.mockRejectedValue(new Error("boom"));
    const res = await POST(req(eocr({ sendPaymentLink: true })));
    expect(res.status).toBe(200);
    const patch = updates.find((u) => u.table === "voice_calls")!.patch;
    expect(patch).toMatchObject({ status: "ended", outcome: "connected" });
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("handoff is invoked for end-of-call-report with the mode read from env (unset → null = OFF)", async () => {
    handoff.mockResolvedValue({ action: "off" });
    await POST(req(eocr({ sendPaymentLink: true })));
    expect(handoff.mock.calls[0][0]).toMatchObject({ voiceCallId: "vc-1", mode: null, structuredData: { sendPaymentLink: true } });
    vi.stubEnv("VOICE_HANDOFF_EMAIL_MODE", "dry_run");
    vi.stubEnv("VOICE_HANDOFF_EMAIL_CLIENT_ID", "client-x");
    await POST(req(eocr({ sendPaymentLink: true })));
    expect(handoff.mock.calls[1][0]).toMatchObject({ mode: "dry_run", clientFence: "client-x" });
  });

  it("status-update never invokes the handoff", async () => {
    await POST(req({ type: "status-update", status: "in-progress", call: { id: "vapi-1", metadata: { voiceCallId: "vc-1" } } }));
    expect(handoff).not.toHaveBeenCalled();
  });

  it("paymentCommitted:false → payment_committed false, committed_* untouched (bug-fix regression)", async () => {
    handoff.mockResolvedValue({ action: "off" });
    await POST(req(eocr({ paymentCommitted: false, committedAmount: 100, committedDate: "2026-10-01" })));
    const patch = updates.find((u) => u.table === "voice_calls")!.patch;
    expect(patch.payment_committed).toBe(false);
    expect(patch).not.toHaveProperty("committed_amount");
    expect(patch).not.toHaveProperty("committed_date");
  });

  it("paymentCommitted:true → payment_committed true with committed_*", async () => {
    handoff.mockResolvedValue({ action: "off" });
    await POST(req(eocr({ paymentCommitted: true, committedAmount: 100, committedDate: "2026-10-01" })));
    const patch = updates.find((u) => u.table === "voice_calls")!.patch;
    expect(patch).toMatchObject({ payment_committed: true, committed_amount: 100, committed_date: "2026-10-01" });
  });

  it("wrong secret → 401, no handoff", async () => {
    const bad = { headers: { get: () => "nope" }, text: async () => "{}" } as never;
    expect((await POST(bad)).status).toBe(401);
    expect(handoff).not.toHaveBeenCalled();
  });
});

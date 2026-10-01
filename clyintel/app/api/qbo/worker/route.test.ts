import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring test: the worker must build CaptureDeps PER PAYMENT with that payment's
// QBO CreateTime (paymentRecordedAt) + TxnDate (event.capturedAt = paymentAt).

vi.mock("@/lib/config/env.server", () => ({ serverEnv: { qboWorkerCronSecret: () => "s3cret" } }));

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "or", "order", "update", "eq"]) b[m] = () => b;
      b.limit = async () => ({
        data: [{ id: "row_1", source: "qbo", raw_payload: { eventNotifications: [] }, attempts: 0 }],
        error: null,
      });
      b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return b;
    },
  }),
}));

const createLiveCaptureDeps = vi.fn((opts?: unknown) => ({ __opts: opts }));
vi.mock("@/lib/capture/captureDepsLive", () => ({
  createLiveCaptureDeps: (opts?: unknown) => createLiveCaptureDeps(opts),
}));

const processCaptureEvent = vi.fn(async () => ({ status: "no_fee", reason: "no_outreach" }));
vi.mock("@/lib/capture/processCaptureEvent", () => ({
  processCaptureEvent: (...a: unknown[]) => (processCaptureEvent as (...x: unknown[]) => unknown)(...a),
}));

const payments: Record<string, { capturedAt: string; createTime: string | null }> = {
  p1: { capturedAt: "2026-09-23T00:00:00.000Z", createTime: "2026-09-22T21:41:37-07:00" },
  p2: { capturedAt: "2026-09-26T00:00:00.000Z", createTime: null },
};
vi.mock("@/lib/qbo/captureAdapter", () => ({
  buildCaptureEventFromPayment: async (_realm: string, paymentId: string) => ({
    event: { source: "qbo", sourcePaymentId: paymentId, capturedAt: payments[paymentId].capturedAt },
    reconcileInput: {},
    paymentRecordedAt: payments[paymentId].createTime,
  }),
}));
vi.mock("@/lib/qbo/reconcileInvoiceFromCapture", () => ({
  reconcileInvoiceFromCapture: async () => ({ status: "reconciled", balanceEventEmitted: false }),
}));
vi.mock("@/lib/qbo/worker", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    parseQboPaymentEntities: () => [
      { realmId: "r", paymentId: "p1" },
      { realmId: "r", paymentId: "p2" },
    ],
  };
});

import { POST } from "./route";

const req = () => ({ headers: { get: () => "Bearer s3cret" } }) as never;

beforeEach(() => {
  createLiveCaptureDeps.mockClear();
  processCaptureEvent.mockClear();
});

describe("qbo/worker route — per-payment CaptureDeps", () => {
  it("builds one deps per payment with THAT payment's CreateTime + TxnDate, and hands it to the core", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);

    expect(createLiveCaptureDeps).toHaveBeenCalledTimes(2);
    expect(createLiveCaptureDeps.mock.calls[0][0]).toEqual({
      paymentAt: "2026-09-23T00:00:00.000Z",
      source: "qbo",
      paymentRecordedAt: "2026-09-22T21:41:37-07:00",
    });
    expect(createLiveCaptureDeps.mock.calls[1][0]).toEqual({
      paymentAt: "2026-09-26T00:00:00.000Z",
      source: "qbo",
      paymentRecordedAt: null,
    });

    // Each core run got its own deps instance (not a shared per-batch one).
    const depsUsed = processCaptureEvent.mock.calls.map((c) => (c as unknown[])[1]);
    expect(depsUsed[0]).toEqual({ __opts: createLiveCaptureDeps.mock.calls[0][0] });
    expect(depsUsed[1]).toEqual({ __opts: createLiveCaptureDeps.mock.calls[1][0] });
    expect(depsUsed[0]).not.toBe(depsUsed[1]);
  });
});

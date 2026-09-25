import { describe, it, expect, vi, beforeEach } from "vitest";

// Route: server-built variables are merged under body.variables (caller wins),
// and a build failure never blocks the call.
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["insert", "select", "update", "eq"]) b[m] = () => b;
      b.single = async () => ({ data: { id: "vc-1" }, error: null });
      b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return b;
    },
  }),
}));

const build = vi.fn();
vi.mock("@/lib/voice/buildCallVariables", () => ({
  buildCallVariables: (...a: unknown[]) => build(...a),
}));

import { POST } from "./route";

const fetchMock = vi.fn();
function req(body: Record<string, unknown>) {
  return { json: async () => body } as never;
}
const baseBody = { subscriberId: "sub", clientId: "cl", invoiceId: "inv", toNumber: "+15551230000" };
const sentVariables = () => JSON.parse(fetchMock.mock.calls[0][1].body).assistantOverrides.variableValues;

beforeEach(() => {
  build.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "vapi-1" }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VAPI_API_KEY", "k");
  vi.stubEnv("VAPI_PHONE_NUMBER_ID", "p");
  vi.stubEnv("VAPI_ASSISTANT_ID", "a");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("voice/call — server-built variables", () => {
  it("ids only → the built variables are sent as variableValues", async () => {
    build.mockResolvedValue({ contact_name: "Vera", amount_due: "$270.00", payment_channel: "email" });
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    expect(build).toHaveBeenCalledWith(expect.anything(), { subscriberId: "sub", clientId: "cl", invoiceId: "inv" });
    expect(sentVariables()).toEqual({ contact_name: "Vera", amount_due: "$270.00", payment_channel: "email" });
  });

  it("body.variables overrides a built key (caller wins), other built keys kept", async () => {
    build.mockResolvedValue({ contact_name: "Vera", amount_due: "$270.00" });
    await POST(req({ ...baseBody, variables: { contact_name: "Forced Name", extra: "x" } }));
    expect(sentVariables()).toEqual({ contact_name: "Forced Name", amount_due: "$270.00", extra: "x" });
  });

  it("buildCallVariables throws → falls back to body.variables and still places the call", async () => {
    build.mockRejectedValue(new Error("db down"));
    const res = await POST(req({ ...baseBody, variables: { contact_name: "Manual" } }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentVariables()).toEqual({ contact_name: "Manual" });
  });

  it("build throws and no body.variables → {} and the call is still placed", async () => {
    build.mockRejectedValue(new Error("db down"));
    await POST(req(baseBody));
    expect(sentVariables()).toEqual({});
  });

  it("missing ids → 400, no build, no call (validation unchanged)", async () => {
    const res = await POST(req({ subscriberId: "sub" }));
    expect(res.status).toBe(400);
    expect(build).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

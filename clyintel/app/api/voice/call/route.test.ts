import { describe, it, expect, vi, beforeEach } from "vitest";

// Route: session auth + tenant ownership gate every call; server-built variables
// are merged under body.variables (caller wins), and a build failure never blocks
// the call.
const inserts: Array<Record<string, unknown>> = [];
const getUser = vi.fn();
vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServer: async () => ({ auth: { getUser } }),
}));
// Ownership lookups: which tables return a row, and the filters they were given.
const owns = { clients: true, invoices: true };
const lookups: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      for (const m of ["select", "update"]) b[m] = () => b;
      b.eq = (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      };
      b.insert = (row: Record<string, unknown>) => {
        inserts.push(row);
        return b;
      };
      b.single = async () => ({ data: { id: "vc-1" }, error: null });
      b.maybeSingle = async () => {
        lookups.push({ table, filters });
        const ok = table === "clients" ? owns.clients : table === "invoices" ? owns.invoices : false;
        return { data: ok ? { id: "row" } : null, error: null };
      };
      b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return b;
    },
  }),
}));

const build = vi.fn();
vi.mock("@/lib/voice/buildCallVariables", () => ({
  buildCallVariables: (...a: unknown[]) => build(...a),
}));

const stamp = vi.fn(async () => "stamped");
vi.mock("@/lib/outreach/markOutreachStarted", () => ({
  markOutreachStarted: (...a: unknown[]) => stamp(...(a as [])),
}));

import { POST } from "./route";

const fetchMock = vi.fn();
function req(body: Record<string, unknown>) {
  return { json: async () => body } as never;
}
// The session user is "sub"; subscriberId is no longer part of the request.
const baseBody = { clientId: "cl", invoiceId: "inv", toNumber: "+15551230000" };
const sentVariables = () => JSON.parse(fetchMock.mock.calls[0][1].body).assistantOverrides.variableValues;

beforeEach(() => {
  build.mockReset();
  stamp.mockClear();
  inserts.length = 0;
  lookups.length = 0;
  owns.clients = true;
  owns.invoices = true;
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: "sub" } }, error: null });
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
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(build).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing invoiceId → 400 'invoiceId is required', no row, no build, no call", async () => {
    const { invoiceId: _omit, ...noInvoice } = baseBody;
    void _omit;
    const res = await POST(req(noInvoice));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invoiceId is required" });
    expect(build).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invoiceId present → unchanged (call placed)", async () => {
    build.mockResolvedValue({});
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("voice/call — session auth and tenant ownership", () => {
  const nothingHappened = () => {
    expect(inserts).toHaveLength(0);
    expect(build).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  };

  it("no session → 401; no lookup, row, variables or call", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(req(baseBody));
    expect(res.status).toBe(401);
    expect(lookups).toHaveLength(0);
    nothingHappened();
  });

  it("auth error → 401 as well", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "jwt expired" } });
    expect((await POST(req(baseBody))).status).toBe(401);
    nothingHappened();
  });

  it("a subscriberId in the body is ignored: the row, the lookups and the variables use the session user", async () => {
    build.mockResolvedValue({});
    const res = await POST(req({ ...baseBody, subscriberId: "victim-tenant" }));
    expect(res.status).toBe(200);
    expect(inserts[0].subscriber_id).toBe("sub");
    expect(build).toHaveBeenCalledWith(expect.anything(), { subscriberId: "sub", clientId: "cl", invoiceId: "inv" });
    for (const l of lookups) expect(l.filters).toContainEqual(["subscriber_id", "sub"]);
    expect(JSON.stringify(inserts)).not.toContain("victim-tenant");
  });

  it("looks up the client and the invoice, each scoped to the session subscriber (invoice also to the client)", async () => {
    build.mockResolvedValue({});
    await POST(req(baseBody));
    const client = lookups.find((l) => l.table === "clients");
    const invoice = lookups.find((l) => l.table === "invoices");
    expect(client?.filters).toEqual([["id", "cl"], ["subscriber_id", "sub"]]);
    expect(invoice?.filters).toEqual([["id", "inv"], ["client_id", "cl"], ["subscriber_id", "sub"]]);
  });

  it("client not owned by the session subscriber → 404 'Not found'; no row, variables or call", async () => {
    owns.clients = false;
    const res = await POST(req(baseBody));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    nothingHappened();
  });

  it("invoice not owned, or not this client's → the same 404; no row, variables or call", async () => {
    owns.invoices = false;
    const res = await POST(req(baseBody));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    nothingHappened();
  });

  it("test mode is gated the same way (test: true cannot skip ownership)", async () => {
    vi.stubEnv("VAPI_ASSISTANT_ID_TEST", "t");
    owns.clients = false;
    expect((await POST(req({ ...baseBody, test: true }))).status).toBe(404);
    nothingHappened();
  });
});

describe("voice/call — outreach-started stamp", () => {
  it("Vapi accepted (200) → stamps the invoice once, channel voice, with an ISO started_at", async () => {
    build.mockResolvedValue({});
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    expect(stamp).toHaveBeenCalledOnce();
    const [, invoiceId, startedAt, channel] = stamp.mock.calls[0] as unknown as [unknown, string, string, string];
    expect(invoiceId).toBe("inv");
    expect(channel).toBe("voice");
    expect(Number.isNaN(Date.parse(startedAt))).toBe(false);
  });

  it("test mode (test: true) → call placed but NO stamp (test calls are not outreach)", async () => {
    vi.stubEnv("VAPI_ASSISTANT_ID_TEST", "a-test");
    build.mockResolvedValue({});
    const res = await POST(req({ ...baseBody, test: true }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).assistantId).toBe("a-test");
    expect(stamp).not.toHaveBeenCalled();
  });

  it("route writes is_test from the request's test flag (false by default, true in test mode)", async () => {
    vi.stubEnv("VAPI_ASSISTANT_ID_TEST", "a-test");
    build.mockResolvedValue({});
    await POST(req(baseBody));
    await POST(req({ ...baseBody, test: true }));
    await POST(req({ ...baseBody, test: "yes" })); // only a strict true is test mode
    expect(inserts.map((r) => r.is_test)).toEqual([false, true, false]);
  });

  it("Vapi rejected the call → no stamp (nothing was placed)", async () => {
    build.mockResolvedValue({});
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: "bad number" }) });
    const res = await POST(req(baseBody));
    expect(res.status).toBe(502);
    expect(stamp).not.toHaveBeenCalled();
  });

  it("network error reaching Vapi → no stamp", async () => {
    build.mockResolvedValue({});
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const res = await POST(req(baseBody));
    expect(res.status).toBe(502);
    expect(stamp).not.toHaveBeenCalled();
  });

  it("validation failure (missing invoiceId) → no stamp", async () => {
    const { invoiceId: _omit, ...noInvoice } = baseBody;
    void _omit;
    await POST(req(noInvoice));
    expect(stamp).not.toHaveBeenCalled();
  });
});

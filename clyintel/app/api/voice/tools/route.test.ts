import { describe, it, expect, vi, beforeEach } from "vitest";

// Route-level: auth, the Vapi tool-calls request/response contract, get_account
// over a table-aware fake DB, dispatch of send_payment_email, batching, audit.

const inserts: { table: string; row: Record<string, unknown> }[] = [];
const CONTACTS = [
  {
    id: "c-dun", client_id: "cl-1", email: "ap@acme.com", phone: null, is_primary: false, role: "AP", name: "Ada",
    opt_out_email: false, opt_out_sms: false, opt_out_voice: true, contact_type: "dunning",
    email_rank: 1, sms_rank: null, voice_rank: null, created_at: "", updated_at: "",
  },
  {
    id: "c-out", client_id: "cl-1", email: "old@acme.com", phone: null, is_primary: false, role: null, name: null,
    opt_out_email: true, opt_out_sms: false, opt_out_voice: false, contact_type: "dunning",
    email_rank: 2, sms_rank: null, voice_rank: null, created_at: "", updated_at: "",
  },
];
const ROWS: Record<string, unknown> = {
  voice_calls: {
    id: "vc-1", subscriber_id: "sub-1", client_id: "cl-1", invoice_id: "inv-1", handoff_email_status: null,
  },
  clients: { name: "Acme", opt_out_email: false, payment_link_url: "https://pay.example/secret" },
  invoices: { invoice_number: "1036", amount_outstanding_cents: 27000, due_date: "2026-06-28" },
};

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "update"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: ROWS[table] ?? null, error: null });
      b.insert = async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { error: null };
      };
      b.then = (resolve: (v: unknown) => void) =>
        resolve({ data: table === "client_contacts" ? CONTACTS : [], error: null });
      return b;
    },
  }),
}));

const sendPaymentEmail = vi.fn();
vi.mock("@/lib/voice/sendPaymentEmailForCall", async (orig) => {
  const real = await orig<typeof import("@/lib/voice/sendPaymentEmailForCall")>();
  return {
    ...real,
    sendPaymentEmailForCall: (...a: unknown[]) => sendPaymentEmail(...a),
    createPaymentEmailPort: () => ({}),
  };
});

import { POST } from "./route";

const SECRET = "vapi-secret";
function req(message: Record<string, unknown>, secret: string | null = SECRET) {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "x-vapi-secret" ? secret : null) },
    text: async () => JSON.stringify({ message }),
  } as never;
}
const toolCalls = (...list: { id: string; name: string; arguments?: unknown }[]) => ({
  type: "tool-calls",
  call: { id: "vapi-1", metadata: { voiceCallId: "vc-1" } },
  toolCallList: list.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments ?? "{}" } })),
});
const body = async (res: Response) => (await res.json()) as { results: Record<string, string>[] };

beforeEach(() => {
  inserts.length = 0;
  sendPaymentEmail.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("voice/tools — auth", () => {
  it("secret not configured → 500", async () => {
    vi.stubEnv("VAPI_WEBHOOK_SECRET", "");
    expect((await POST(req(toolCalls({ id: "t1", name: "get_account" })))).status).toBe(500);
  });

  it("wrong / missing x-vapi-secret → 401, nothing run or written", async () => {
    expect((await POST(req(toolCalls({ id: "t1", name: "send_payment_email" }), "nope"))).status).toBe(401);
    expect((await POST(req(toolCalls({ id: "t1", name: "send_payment_email" }), null))).status).toBe(401);
    expect(sendPaymentEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});

describe("voice/tools — get_account", () => {
  it("returns {results:[{toolCallId,name,result}]} with the account JSON: FULL emails, emailable, NO link", async () => {
    const res = await POST(req(toolCalls({ id: "t1", name: "get_account" })));
    expect(res.status).toBe(200);
    const { results } = await body(res);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("t1");
    expect(results[0].name).toBe("get_account");
    const view = JSON.parse(results[0].result);
    expect(view).toEqual({
      client_name: "Acme",
      invoice: { number: "1036", amount_due: "$270.00", due_date: "June 28, 2026" },
      contacts: [
        { contact_id: "c-dun", name: "Ada", role: "AP", contact_type: "dunning", email: "ap@acme.com", emailable: true },
        { contact_id: "c-out", name: null, role: null, contact_type: "dunning", email: "old@acme.com", emailable: false },
      ],
      default_contact_id: "c-dun",
      payment_email_status: null,
    });
    expect(results[0].result).not.toContain("pay.example");
    expect(sendPaymentEmail).not.toHaveBeenCalled();
  });

  it("writes exactly one voice_call_events audit row per request", async () => {
    await POST(req(toolCalls({ id: "t1", name: "get_account" }, { id: "t2", name: "get_account" })));
    const audits = inserts.filter((i) => i.table === "voice_call_events");
    expect(audits).toHaveLength(1);
    expect(audits[0].row).toMatchObject({ event_type: "tool-calls", vapi_call_id: "vapi-1", matched_voice_call_id: "vc-1" });
  });
});

describe("voice/tools — send_payment_email dispatch", () => {
  it("arguments as a JSON string → orchestrator gets voiceCallId, email, contact_id, mode from env", async () => {
    vi.stubEnv("VOICE_HANDOFF_EMAIL_MODE", "dry_run");
    vi.stubEnv("VOICE_HANDOFF_EMAIL_CLIENT_ID", "cl-1");
    sendPaymentEmail.mockResolvedValue({ action: "would_send", toAddress: "new@example.com", communicationId: "comm-1" });
    const res = await POST(
      req(toolCalls({ id: "t9", name: "send_payment_email", arguments: JSON.stringify({ email: "new@example.com", contact_id: "c-dun" }) })),
    );
    expect(sendPaymentEmail.mock.calls[0][0]).toEqual({
      voiceCallId: "vc-1",
      email: "new@example.com",
      contactId: "c-dun",
      mode: "dry_run",
      clientFence: "cl-1",
    });
    const { results } = await body(res);
    expect(results[0]).toEqual({
      toolCallId: "t9",
      name: "send_payment_email",
      result: "recorded in test mode, not delivered (would have gone to new@example.com).",
    });
  });

  it("arguments as an object; no args → email/contactId null; mode unset → null (OFF)", async () => {
    sendPaymentEmail.mockResolvedValue({ action: "off" });
    await POST(req(toolCalls({ id: "t1", name: "send_payment_email", arguments: { contact_id: "c-dun" } })));
    expect(sendPaymentEmail.mock.calls[0][0]).toMatchObject({ email: null, contactId: "c-dun", mode: null });
    await POST(req(toolCalls({ id: "t2", name: "send_payment_email", arguments: "not json" })));
    expect(sendPaymentEmail.mock.calls[1][0]).toMatchObject({ email: null, contactId: null });
  });

  it("an orchestrator error outcome comes back as a per-item `error`, still HTTP 200", async () => {
    sendPaymentEmail.mockResolvedValue({ action: "invalid_target", reason: "opted_out" });
    const res = await POST(req(toolCalls({ id: "t1", name: "send_payment_email", arguments: "{}" })));
    expect(res.status).toBe(200);
    const { results } = await body(res);
    expect(results[0].error).toContain("opted out");
    expect(results[0]).not.toHaveProperty("result");
  });
});

describe("voice/tools — batching, unknown tools, robustness", () => {
  it("a batched toolCallList with two items → two results, in order", async () => {
    sendPaymentEmail.mockResolvedValue({ action: "sent", toAddress: "ap@acme.com", communicationId: "comm-1" });
    const res = await POST(
      req(toolCalls({ id: "a", name: "get_account" }, { id: "b", name: "send_payment_email", arguments: "{}" })),
    );
    const { results } = await body(res);
    expect(results.map((r) => [r.toolCallId, r.name])).toEqual([
      ["a", "get_account"],
      ["b", "send_payment_email"],
    ]);
    expect(results[1].result).toBe("sent to ap@acme.com. Tell the caller to check their inbox.");
  });

  it("unknown function → per-item error; the others still run", async () => {
    const res = await POST(req(toolCalls({ id: "x", name: "transfer_funds" }, { id: "y", name: "get_account" })));
    const { results } = await body(res);
    expect(results[0]).toEqual({ toolCallId: "x", name: "transfer_funds", error: 'Unknown tool "transfer_funds".' });
    expect(results[1].result).toBeDefined();
  });

  it("a throwing tool → per-item error, 200", async () => {
    sendPaymentEmail.mockRejectedValue(new Error("boom"));
    const res = await POST(req(toolCalls({ id: "t", name: "send_payment_email" })));
    expect(res.status).toBe(200);
    expect((await body(res)).results[0].error).toBeDefined();
  });

  it("unparseable body → 200 with empty results", async () => {
    const bad = {
      headers: { get: (k: string) => (k.toLowerCase() === "x-vapi-secret" ? SECRET : null) },
      text: async () => "{nope",
    } as never;
    const res = await POST(bad);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });
});

describe("voice/tools — TEMPORARY tools-diag row", () => {
  it("send_payment_email writes one tools-diag row with the expected keys; the tool response is unchanged", async () => {
    vi.stubEnv("VOICE_HANDOFF_EMAIL_MODE", "live ");
    vi.stubEnv("VOICE_HANDOFF_EMAIL_CLIENT_ID", "cl-1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "develop");
    sendPaymentEmail.mockResolvedValue({ action: "off" });
    const res = await POST(req(toolCalls({ id: "t1", name: "send_payment_email", arguments: "{}" })));

    expect(res.status).toBe(200);
    expect((await body(res)).results).toEqual([
      { toolCallId: "t1", name: "send_payment_email", result: expect.stringContaining("isn't available") },
    ]);
    const diags = inserts.filter((i) => i.row.event_type === "tools-diag");
    expect(diags).toHaveLength(1);
    expect(diags[0].table).toBe("voice_call_events");
    expect(diags[0].row).toMatchObject({ vapi_call_id: "vapi-1", matched_voice_call_id: "vc-1" });
    const raw = diags[0].row.raw as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      ["clientFenceMatches", "clientFenceSet", "deploymentUrl", "gitRef", "gitSha", "modeParsed", "modeRaw", "vercelEnv"],
    );
    expect(raw).toMatchObject({
      modeRaw: '"live "', // quotes expose the trailing space
      modeParsed: null,
      clientFenceSet: true,
      clientFenceMatches: true,
      vercelEnv: "preview",
      gitRef: "develop",
    });
    expect(JSON.stringify(raw)).not.toContain(SECRET);
  });

  it("get_account alone writes no tools-diag row", async () => {
    await POST(req(toolCalls({ id: "t1", name: "get_account" })));
    expect(inserts.filter((i) => i.row.event_type === "tools-diag")).toHaveLength(0);
  });
});

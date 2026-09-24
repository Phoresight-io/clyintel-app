import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "crypto";
import type { NextRequest } from "next/server";

// POST's real path hands work to waitUntil over the default Supabase port. Both
// are module-mocked so the end-to-end POST tests can (a) await the async work and
// (b) observe every DB read/write. No real DB is touched.
const h = vi.hoisted(() => ({
  client: null as unknown,
  pending: [] as Promise<unknown>[],
}));
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => {
    if (!h.client) throw new Error("getSupabase called with no fake installed");
    return h.client;
  },
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    h.pending.push(p);
  },
}));

import {
  POST,
  processMailersendEvent,
  MAILERSEND_TEST_PING_SECRET,
  type MailersendWebhookPort,
} from "./route";
import { ATTENTION_REASON } from "@/lib/outreach/deriveAttentionReason";

const SECRET = "whsec_route_test";

// ── POST helpers ─────────────────────────────────────────────────────────────
// POST only touches req.text() and req.headers.get(); a plain web Request
// satisfies both, so we cast rather than construct a full NextRequest.
function sign(raw: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}

function makeReq(raw: string, signature: string | null): NextRequest {
  const headers = new Headers();
  if (signature !== null) headers.set("signature", signature);
  return new Request("https://example.com/api/webhooks/mailersend", {
    method: "POST",
    body: raw,
    headers,
  }) as unknown as NextRequest;
}

const ORIGINAL_SECRET = process.env.MAILERSEND_WEBHOOK_SECRET;
afterEach(() => {
  h.client = null;
  h.pending = [];
  if (ORIGINAL_SECRET === undefined) delete process.env.MAILERSEND_WEBHOOK_SECRET;
  else process.env.MAILERSEND_WEBHOOK_SECRET = ORIGINAL_SECRET;
  vi.restoreAllMocks();
});

describe("POST — signature gate (verify before any write)", () => {
  it("Condition 3: MAILERSEND_WEBHOOK_SECRET unset → 401, no processing (fail-closed)", async () => {
    delete process.env.MAILERSEND_WEBHOOK_SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = JSON.stringify({ type: "activity.spam_complaint" });
    // Even a "correct-looking" signature cannot help: with no secret we reject all.
    const res = await POST(makeReq(raw, "deadbeef"));
    expect(res.status).toBe(401);
  });

  it("bad signature → 401, no processing", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    const raw = JSON.stringify({ type: "activity.spam_complaint" });
    const res = await POST(makeReq(raw, sign(raw, "wrong-secret")));
    expect(res.status).toBe(401);
  });

  it("missing signature header → 401, no processing", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    const raw = JSON.stringify({ type: "activity.spam_complaint" });
    const res = await POST(makeReq(raw, null));
    expect(res.status).toBe(401);
  });

  it("valid signature → 200 ack", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    installFakeDb();
    // Unknown message-id shape → processor no-ops; POST still 200-acks synchronously.
    const raw = JSON.stringify({ data: { email: {} }, type: "activity.opened" });
    const res = await POST(makeReq(raw, sign(raw)));
    expect(res.status).toBe(200);
  });
});

// ── Minimal recording Supabase fake for the default port ─────────────────────
// Supports exactly the chains createDefaultPort uses; every call is recorded so
// tests can assert "no DB access at all" as well as specific writes.
type DbCall = { table: string; op: "select" | "update"; patch?: Record<string, unknown> };
function installFakeDb(seed: {
  comm?: { id: string; client_id: string | null; subscriber_id: string | null } | null;
  contacts?: { id: string; is_primary: boolean; opt_out_email: boolean }[];
  attention?: string | null;
} = {}) {
  const calls: DbCall[] = [];
  const rowsFor = (table: string): unknown => {
    if (table === "communications") return seed.comm ?? null;
    if (table === "client_contacts") return seed.contacts ?? [];
    if (table === "clients") return { attention_reason: seed.attention ?? null };
    return null;
  };
  const client = {
    from(table: string) {
      return {
        select() {
          calls.push({ table, op: "select" });
          const res = { data: rowsFor(table), error: null };
          const chain = {
            eq: () => chain,
            limit: () => chain,
            maybeSingle: async () => res,
            then: (ok: (v: typeof res) => unknown) => Promise.resolve(res).then(ok),
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          calls.push({ table, op: "update", patch });
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  h.client = client;
  return calls;
}

describe("POST — MailerSend URL-validation ping (webhook.test)", () => {
  const ping = () =>
    JSON.stringify({ type: "webhook.test", url: "https://clyintel.vercel.app/api/webhooks/mailersend" });

  it("signed with the fixed test secret → 200, no processing, no DB access", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    const calls = installFakeDb();
    const raw = ping();
    const res = await POST(makeReq(raw, sign(raw, MAILERSEND_TEST_PING_SECRET)));
    expect(res.status).toBe(200);
    expect(h.pending).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("works with MAILERSEND_WEBHOOK_SECRET UNSET → 200", async () => {
    delete process.env.MAILERSEND_WEBHOOK_SECRET;
    const calls = installFakeDb();
    const raw = ping();
    const res = await POST(makeReq(raw, sign(raw, MAILERSEND_TEST_PING_SECRET)));
    expect(res.status).toBe(200);
    expect(h.pending).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("bad signature → 401", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    const raw = ping();
    const res = await POST(makeReq(raw, sign(raw, "not-the-test-secret")));
    expect(res.status).toBe(401);
    expect(h.pending).toHaveLength(0);
  });

  it("signed with OUR secret (not the test secret) → 401", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    const raw = ping();
    const res = await POST(makeReq(raw, sign(raw, SECRET)));
    expect(res.status).toBe(401);
  });

  it("missing signature header → 401", async () => {
    delete process.env.MAILERSEND_WEBHOOK_SECRET;
    const raw = ping();
    const res = await POST(makeReq(raw, null));
    expect(res.status).toBe(401);
  });

  it("a real activity event signed with the PUBLIC test secret → 401 (no bypass of the real gate)", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    const calls = installFakeDb();
    const raw = JSON.stringify(event("activity.spam_complaint"));
    const res = await POST(makeReq(raw, sign(raw, MAILERSEND_TEST_PING_SECRET)));
    expect(res.status).toBe(401);
    expect(h.pending).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("POST — real activity.spam_complaint (unchanged, end-to-end)", () => {
  const seed = {
    comm: { id: "comm-1", client_id: "client-1", subscriber_id: "sub-1" },
    contacts: [{ id: "contact-1", is_primary: true, opt_out_email: false }],
    attention: null,
  };

  it("still fail-closed: MAILERSEND_WEBHOOK_SECRET unset → 401, no DB access", async () => {
    delete process.env.MAILERSEND_WEBHOOK_SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = installFakeDb(seed);
    const raw = JSON.stringify(event("activity.spam_complaint"));
    const res = await POST(makeReq(raw, sign(raw)));
    expect(res.status).toBe(401);
    expect(h.pending).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("validly signed with our secret → 200, then sets client_contacts.opt_out_email = true", async () => {
    process.env.MAILERSEND_WEBHOOK_SECRET = SECRET;
    const calls = installFakeDb(seed);
    const raw = JSON.stringify(event("activity.spam_complaint"));
    const res = await POST(makeReq(raw, sign(raw)));
    expect(res.status).toBe(200);
    expect(h.pending).toHaveLength(1);
    await Promise.all(h.pending);
    expect(calls).toContainEqual({
      table: "client_contacts",
      op: "update",
      patch: { opt_out_email: true },
    });
    expect(calls).toContainEqual({
      table: "clients",
      op: "update",
      patch: { attention_reason: ATTENTION_REASON.spam_complaint },
    });
  });
});

// ── processMailersendEvent — deterministic effects via a fake port ────────────
function makePort(over: Partial<MailersendWebhookPort> = {}): MailersendWebhookPort {
  return {
    findCommunicationByMessageId: vi.fn(async () => ({
      id: "comm-1",
      client_id: "client-1",
      subscriber_id: "sub-1",
    })),
    loadPrimaryContact: vi.fn(async () => ({ id: "contact-1", opt_out_email: false })),
    loadClientAttentionReason: vi.fn(async () => null as string | null),
    setContactOptOutEmail: vi.fn(async () => {}),
    setClientAttentionReason: vi.fn(async () => {}),
    updateCommunicationActivity: vi.fn(async () => {}),
    ...over,
  };
}

// message-id lives at data.email.message.id; type drives classification.
function event(type: string, messageId: string | null = "ms-1"): unknown {
  return {
    type,
    data: { email: messageId === null ? {} : { message: { id: messageId } } },
  };
}

describe("processMailersendEvent — resolution", () => {
  it("no message id → 'no_message_id', nothing touched", async () => {
    const port = makePort();
    const out = await processMailersendEvent(event("activity.spam_complaint", null), port);
    expect(out).toBe("no_message_id");
    expect(port.findCommunicationByMessageId).not.toHaveBeenCalled();
  });

  it("unknown message id → 'unknown_message_id', NO write (200 ack upstream)", async () => {
    const port = makePort({ findCommunicationByMessageId: vi.fn(async () => null) });
    const out = await processMailersendEvent(event("activity.spam_complaint"), port);
    expect(out).toBe("unknown_message_id");
    expect(port.setContactOptOutEmail).not.toHaveBeenCalled();
    expect(port.setClientAttentionReason).not.toHaveBeenCalled();
  });

  it("resolves BY MESSAGE-ID (lookup arg is the message id, never an email)", async () => {
    const find = vi.fn(async () => ({ id: "comm-1", client_id: "client-1", subscriber_id: "sub-1" }));
    const port = makePort({ findCommunicationByMessageId: find });
    await processMailersendEvent(event("activity.spam_complaint", "ms-xyz"), port);
    expect(find).toHaveBeenCalledWith("ms-xyz");
  });
});

describe("processMailersendEvent — event effects", () => {
  it("spam complaint → opt-out + attention(spam_complaint)", async () => {
    const port = makePort();
    const out = await processMailersendEvent(event("activity.spam_complaint"), port);
    expect(out).toBe("opt_out");
    expect(port.setContactOptOutEmail).toHaveBeenCalledWith("contact-1");
    expect(port.setClientAttentionReason).toHaveBeenCalledWith(
      "client-1",
      ATTENTION_REASON.spam_complaint,
    );
  });

  it("unsubscribe → opt-out + attention(opt_out)", async () => {
    const port = makePort();
    const out = await processMailersendEvent(event("activity.unsubscribed"), port);
    expect(out).toBe("opt_out");
    expect(port.setContactOptOutEmail).toHaveBeenCalledWith("contact-1");
    expect(port.setClientAttentionReason).toHaveBeenCalledWith(
      "client-1",
      ATTENTION_REASON.opt_out,
    );
  });

  it("hard bounce → attention only, NEVER opt-out", async () => {
    const port = makePort();
    const out = await processMailersendEvent(event("activity.hard_bounced"), port);
    expect(out).toBe("attention_only");
    expect(port.setContactOptOutEmail).not.toHaveBeenCalled();
    expect(port.setClientAttentionReason).toHaveBeenCalledWith(
      "client-1",
      ATTENTION_REASON.hard_bounce,
    );
  });

  it("soft bounce → 'ignored', no opt-out, no attention", async () => {
    const port = makePort();
    const out = await processMailersendEvent(event("activity.soft_bounced"), port);
    expect(out).toBe("ignored");
    expect(port.setContactOptOutEmail).not.toHaveBeenCalled();
    expect(port.setClientAttentionReason).not.toHaveBeenCalled();
    expect(port.loadPrimaryContact).not.toHaveBeenCalled();
  });

  it("delivered → activity (communications status only), no opt-out/attention", async () => {
    const port = makePort();
    const out = await processMailersendEvent(event("activity.delivered"), port);
    expect(out).toBe("activity");
    expect(port.updateCommunicationActivity).toHaveBeenCalledWith("comm-1", "activity.delivered");
    expect(port.setContactOptOutEmail).not.toHaveBeenCalled();
    expect(port.setClientAttentionReason).not.toHaveBeenCalled();
  });
});

describe("processMailersendEvent — idempotency & monotonicity", () => {
  it("replayed opt-out (contact already opted out) → no redundant write (no thrash)", async () => {
    const port = makePort({
      loadPrimaryContact: vi.fn(async () => ({ id: "contact-1", opt_out_email: true })),
      loadClientAttentionReason: vi.fn(async () => ATTENTION_REASON.spam_complaint as string | null),
    });
    const out = await processMailersendEvent(event("activity.spam_complaint"), port);
    expect(out).toBe("opt_out");
    // Already opted out → no re-write. Attention already spam_complaint → no re-write.
    expect(port.setContactOptOutEmail).not.toHaveBeenCalled();
    expect(port.setClientAttentionReason).not.toHaveBeenCalled();
  });

  it("Condition 2: existing spam_complaint, then hard_bounce → attention stays spam_complaint (no downgrade, no write)", async () => {
    const port = makePort({
      loadClientAttentionReason: vi.fn(async () => ATTENTION_REASON.spam_complaint as string | null),
    });
    const out = await processMailersendEvent(event("activity.hard_bounced"), port);
    expect(out).toBe("attention_only");
    // Re-derived reason equals current → write is skipped entirely.
    expect(port.setClientAttentionReason).not.toHaveBeenCalled();
  });

  it("escalates when incoming is more severe than current (opt_out → hard_bounce writes)", async () => {
    const port = makePort({
      loadClientAttentionReason: vi.fn(async () => ATTENTION_REASON.opt_out as string | null),
    });
    const out = await processMailersendEvent(event("activity.hard_bounced"), port);
    expect(out).toBe("attention_only");
    expect(port.setClientAttentionReason).toHaveBeenCalledWith(
      "client-1",
      ATTENTION_REASON.hard_bounce,
    );
  });
});

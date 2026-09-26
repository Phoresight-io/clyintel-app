import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sendPaymentEmailForCall,
  toToolResponse,
  resolveTarget,
  isPlausibleEmail,
  type ClientEmailContext,
  type PaymentEmailPort,
} from "./sendPaymentEmailForCall";
import type { HandoffCall } from "./handoffEmail";
import type { SendEmailStepContext, SendEmailStepResult } from "../outreach/sendEmailStep";
import type { ContactRow } from "../outreach/selectRecipients";

const CALL_ID = "vc-1";
const CLIENT = "client-1";
const NOW = "2026-09-26T02:00:00.000Z";

const contact = (over: Partial<ContactRow>): ContactRow => ({
  id: "c1",
  client_id: CLIENT,
  email: "ap@acme.com",
  phone: null,
  is_primary: false,
  role: null,
  name: "Ada",
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
  contact_type: "dunning",
  email_rank: 1,
  sms_rank: null,
  voice_rank: null,
  created_at: "",
  updated_at: "",
  ...over,
});

const DUNNING = contact({ id: "c-dun" });
const POC = contact({ id: "c-poc", contact_type: "poc", email: "owner@acme.com", email_rank: 2 });
const OUT = contact({ id: "c-out", email: "old@acme.com", email_rank: 3, opt_out_email: true });
const NO_EMAIL = contact({ id: "c-none", email: null, email_rank: null });

const baseCall = (over: Partial<HandoffCall> = {}): HandoffCall => ({
  id: CALL_ID,
  subscriber_id: "sub-1",
  client_id: CLIENT,
  invoice_id: "inv-1",
  outcome: null, // mid-call
  invoice_outstanding_cents: 27000,
  ...over,
});

const stepResult = (over: Partial<SendEmailStepResult> = {}): SendEmailStepResult => ({
  outcome: "sent",
  communicationId: "comm-1",
  recoveryAttemptId: "ra-1",
  mailersendMessageId: "ms-1",
  ...over,
});

// In-memory port. `state.status` models voice_calls.handoff_email_status and the
// DB's guarded updates: claim only from NULL, finalize/release only from 'claimed'.
function fakePort(
  opts: {
    call?: HandoffCall | null;
    emailCtx?: ClientEmailContext | null;
    step?: (ctx: SendEmailStepContext, mode: string) => Promise<SendEmailStepResult>;
    status?: string | null;
    toAddress?: string | null;
  } = {},
) {
  const state = { status: opts.status ?? null, toAddress: opts.toAddress ?? null, writes: 0 };
  const port = {
    loadCall: vi.fn(async () => (opts.call === undefined ? baseCall() : opts.call)),
    loadClientEmailContext: vi.fn(async () =>
      opts.emailCtx === undefined ? { clientOptOutEmail: false, contacts: [DUNNING, POC, OUT, NO_EMAIL] } : opts.emailCtx,
    ),
    loadPriorSend: vi.fn(async () => ({ status: state.status, toAddress: state.toAddress })),
    claimOrRecord: vi.fn(async (_id: string, next: { status: string }) => {
      state.writes++;
      if (state.status !== null) return false;
      state.status = next.status;
      return true;
    }),
    finalize: vi.fn(async (_id: string, patch: { status: string }) => {
      state.writes++;
      if (state.status === "claimed") state.status = patch.status;
    }),
    release: vi.fn(async () => {
      state.writes++;
      if (state.status === "claimed") state.status = null;
    }),
    sendEmailStep: vi.fn(opts.step ?? (async (_ctx: SendEmailStepContext, _mode: string) => stepResult())),
    now: () => NOW,
  } satisfies PaymentEmailPort;
  return { port, state };
}

const run = (port: PaymentEmailPort, over: Partial<Parameters<typeof sendPaymentEmailForCall>[0]> = {}) =>
  sendPaymentEmailForCall({ voiceCallId: CALL_ID, mode: "live", ...over }, port);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("1. mode fence", () => {
  it("OFF → nothing read or written; the agent is told email isn't available", async () => {
    const { port, state } = fakePort();
    const r = await run(port, { mode: null });
    expect(r).toEqual({ action: "off" });
    expect(port.loadCall).not.toHaveBeenCalled();
    expect(state.writes).toBe(0);
    expect(toToolResponse(r)).toEqual({ result: expect.stringContaining("isn't available") });
  });
});

describe("2. record gates (read-only, no write)", () => {
  it.each([
    ["no_call", { call: null }, { action: "no_call" }],
    ["no_invoice", { call: baseCall({ invoice_id: null }) }, { action: "skipped", reason: "no_invoice" }],
    ["invoice_not_open (0)", { call: baseCall({ invoice_outstanding_cents: 0 }) }, { action: "skipped", reason: "invoice_not_open" }],
    ["invoice_not_open (null)", { call: baseCall({ invoice_outstanding_cents: null }) }, { action: "skipped", reason: "invoice_not_open" }],
  ])("%s", async (_l, opts, expected) => {
    const { port, state } = fakePort(opts);
    expect(await run(port)).toEqual(expected);
    expect(state.writes).toBe(0);
    expect(port.sendEmailStep).not.toHaveBeenCalled();
  });

  it("client fence set to another client → client_fenced; same client passes", async () => {
    const a = fakePort();
    expect(await run(a.port, { clientFence: "other" })).toEqual({ action: "skipped", reason: "client_fenced" });
    expect(a.state.writes).toBe(0);
    const b = fakePort();
    expect((await run(b.port, { clientFence: CLIENT })).action).toBe("sent");
  });
});

describe("3. target validation BEFORE the claim — error, NO write, agent can ask again", () => {
  it.each([
    ["invalid email syntax", { email: "ap at acme dot com" }, "invalid_email"],
    ["contact not on this client", { contactId: "someone-elses" }, "contact_not_found"],
    ["contact has no email", { contactId: "c-none" }, "no_email_on_contact"],
    ["opted-out contact", { contactId: "c-out" }, "opted_out"],
    ["spoken address of an opted-out contact", { email: "OLD@acme.com" }, "opted_out"],
  ])("%s → invalid_target", async (_l, choice, reason) => {
    const { port, state } = fakePort();
    const r = await run(port, choice);
    expect(r).toEqual({ action: "invalid_target", reason });
    expect(state.writes).toBe(0);
    expect(state.status).toBeNull();
    expect(port.sendEmailStep).not.toHaveBeenCalled();
    expect("error" in toToolResponse(r)).toBe(true);
  });

  it("clients.opt_out_email true → client_opted_out on every path, no write", async () => {
    for (const choice of [{ email: "new@example.com" }, { contactId: "c-dun" }, {}]) {
      const { port, state } = fakePort({ emailCtx: { clientOptOutEmail: true, contacts: [DUNNING] } });
      expect(await run(port, choice)).toEqual({ action: "invalid_target", reason: "client_opted_out" });
      expect(state.writes).toBe(0);
    }
  });

  it("no email on file and none given → no_default_contact", async () => {
    const { port } = fakePort({ emailCtx: { clientOptOutEmail: false, contacts: [NO_EMAIL] } });
    expect(await run(port)).toEqual({ action: "invalid_target", reason: "no_default_contact" });
  });

  it("the invalid call is retryable: a corrected address then sends", async () => {
    const { port, state } = fakePort();
    await run(port, { email: "bad" });
    const r = await run(port, { email: "new@example.com" });
    expect(r).toEqual({ action: "sent", toAddress: "new@example.com", communicationId: "comm-1" });
    expect(state.status).toBe("sent");
  });
});

describe("5. target priority → the recipient override passed to sendEmailStep", () => {
  it("spoken email wins over contact_id", async () => {
    const { port } = fakePort();
    await run(port, { email: " new@example.com ", contactId: "c-poc" });
    expect(port.sendEmailStep.mock.calls[0][0]).toEqual({
      subscriberId: "sub-1",
      clientId: CLIENT,
      invoiceId: "inv-1",
      recipient: { email: "new@example.com" },
      clientOptOutEmail: false,
    });
  });

  it("contact_id when no email", async () => {
    const { port } = fakePort();
    const r = await run(port, { contactId: "c-poc" });
    expect(port.sendEmailStep.mock.calls[0][0].recipient).toEqual({ contactId: "c-poc" });
    expect(r).toMatchObject({ action: "sent", toAddress: "owner@acme.com" });
  });

  it("neither → the default emailable contact, passed as an explicit contactId", async () => {
    const { port } = fakePort();
    const r = await run(port);
    expect(port.sendEmailStep.mock.calls[0][0].recipient).toEqual({ contactId: "c-dun" });
    expect(r).toMatchObject({ action: "sent", toAddress: "ap@acme.com" });
  });
});

describe("happy paths — terminal, never released", () => {
  it("live → exactly one sendEmailStep('live'), finalized sent", async () => {
    const { port, state } = fakePort();
    const r = await run(port, { contactId: "c-dun" });
    expect(port.sendEmailStep).toHaveBeenCalledTimes(1);
    expect(port.sendEmailStep.mock.calls[0][1]).toBe("live");
    expect(r).toEqual({ action: "sent", toAddress: "ap@acme.com", communicationId: "comm-1" });
    expect(state.status).toBe("sent");
    expect(port.release).not.toHaveBeenCalled();
    expect(toToolResponse(r)).toEqual({ result: "sent to ap@acme.com. Tell the caller to check their inbox." });
  });

  it("dry_run → would_send, terminal, told 'recorded in test mode, not delivered'", async () => {
    const { port, state } = fakePort({ step: async () => stepResult({ outcome: "would_send", mailersendMessageId: null }) });
    const r = await run(port, { mode: "dry_run" });
    expect(port.sendEmailStep.mock.calls[0][1]).toBe("dry_run");
    expect(r).toMatchObject({ action: "would_send", toAddress: "ap@acme.com" });
    expect(state.status).toBe("would_send");
    expect(port.release).not.toHaveBeenCalled();
    expect(toToolResponse(r)).toEqual({ result: expect.stringContaining("recorded in test mode, not delivered") });
  });
});

describe("4. one email per call — duplicates are a RESULT, not an error", () => {
  it("second call after a live send → already_sent to the prior address; no second send", async () => {
    const { port } = fakePort();
    await run(port);
    const second = fakePort({ status: "sent", toAddress: "ap@acme.com" });
    const r = await run(second.port, { email: "another@example.com" });
    expect(r).toEqual({ action: "duplicate", priorStatus: "sent", toAddress: "ap@acme.com" });
    expect(second.port.sendEmailStep).not.toHaveBeenCalled();
    expect(second.port.claimOrRecord).not.toHaveBeenCalled();
    expect(toToolResponse(r)).toEqual({
      result: "already_sent: a payment link was already emailed on this call to ap@acme.com.",
    });
  });

  it("same port, called twice → exactly one send", async () => {
    const { port } = fakePort();
    await run(port);
    const r = await run(port);
    expect(r.action).toBe("duplicate");
    expect(port.sendEmailStep).toHaveBeenCalledTimes(1);
  });

  it("prior would_send → the test-mode already_sent line", () => {
    expect(toToolResponse({ action: "duplicate", priorStatus: "would_send", toAddress: "x@y.com" })).toEqual({
      result: "already_sent: a payment link was already recorded in test mode on this call (to x@y.com), not delivered.",
    });
  });

  it("claim lost to a concurrent invocation (0 rows) → duplicate, no send", async () => {
    const { port, state } = fakePort();
    port.claimOrRecord.mockImplementationOnce(async () => {
      state.status = "claimed"; // the other invocation won
      return false;
    });
    const r = await run(port);
    expect(r).toEqual({ action: "duplicate", priorStatus: "claimed", toAddress: null });
    expect(port.sendEmailStep).not.toHaveBeenCalled();
    expect(toToolResponse(r)).toEqual({ result: expect.stringContaining("already_attempted") });
  });
});

describe("6. PRE-DISPATCH gate → claim RELEASED to NULL, retryable", () => {
  it.each(["no_primary_contact", "channel_denied", "no_template", "no_payment_link", "recipient_not_found"] as const)(
    "%s → released; row NULL again; a re-invocation can re-claim",
    async (gate) => {
      const { port, state } = fakePort({ step: async () => stepResult({ outcome: gate, communicationId: null }) });
      const r = await run(port);
      expect(r).toEqual({ action: "released", reason: gate });
      expect(port.release).toHaveBeenCalledTimes(1);
      expect(port.finalize).not.toHaveBeenCalled();
      expect(state.status).toBeNull();
      expect("error" in toToolResponse(r)).toBe(true);

      // Retry on the same call: claims again and sends.
      port.sendEmailStep.mockImplementation(async () => stepResult());
      const again = await run(port);
      expect(again.action).toBe("sent");
      expect(state.status).toBe("sent");
    },
  );
});

describe("6. send_failed / throw → TERMINAL (cannot be proven pre-dispatch)", () => {
  it("send_failed → finalized failed, NOT released; a retry is a duplicate", async () => {
    const { port, state } = fakePort({ step: async () => stepResult({ outcome: "send_failed", mailersendMessageId: null }) });
    const r = await run(port);
    expect(r).toEqual({ action: "failed", reason: "send_failed", communicationId: "comm-1" });
    expect(port.release).not.toHaveBeenCalled();
    expect(state.status).toBe("failed");
    const retry = await run(port);
    expect(retry.action).toBe("duplicate");
    expect(port.sendEmailStep).toHaveBeenCalledTimes(1);
  });

  it("sendEmailStep throws → finalized failed, not released, function does not throw", async () => {
    const { port, state } = fakePort({
      step: async () => {
        throw new Error("x".repeat(900));
      },
    });
    const r = await run(port);
    expect(r.action).toBe("failed");
    expect((r as { reason: string }).reason).toHaveLength(500);
    expect(port.release).not.toHaveBeenCalled();
    expect(state.status).toBe("failed");
  });

  it("port errors → { action: 'error' }, never throws", async () => {
    const { port } = fakePort();
    port.loadCall.mockRejectedValueOnce(new Error("db down"));
    expect(await run(port)).toEqual({ action: "error", reason: "db down" });
  });
});

describe("pure helpers", () => {
  it("isPlausibleEmail", () => {
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    for (const bad of ["", "a@b", "a b@c.com", "ab.com", "a@@b.com"]) expect(isPlausibleEmail(bad)).toBe(false);
  });

  it("resolveTarget never returns the link or touches the DB — just the recipient", () => {
    expect(resolveTarget({ clientOptOutEmail: false, contacts: [DUNNING] }, {})).toEqual({
      recipient: { contactId: "c-dun" },
      toAddress: "ap@acme.com",
    });
  });
});

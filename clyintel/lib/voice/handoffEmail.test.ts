import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createHandoffPort,
  maybeSendVoiceHandoffEmail,
  parseHandoffMode,
  type HandoffCall,
  type HandoffPort,
} from "./handoffEmail";
import type { SendEmailStepResult } from "../outreach/sendEmailStep";

const CALL_ID = "vc-1";
const SUB = "sub-1";
const CLIENT = "9e38c5f4-0d88-41c6-a968-394b9202f440";
const INVOICE = "inv-1036";
const NOW = "2026-09-25T22:00:00.000Z";

const baseCall = (over: Partial<HandoffCall> = {}): HandoffCall => ({
  id: CALL_ID,
  subscriber_id: SUB,
  client_id: CLIENT,
  invoice_id: INVOICE,
  outcome: "connected",
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

// In-memory port. `claimGrants` models the DB's NULL-guarded update: the first
// transition off NULL wins, every later one gets 0 rows.
function fakePort(opts: { call?: HandoffCall | null; step?: () => Promise<SendEmailStepResult> } = {}) {
  let status: string | null = null;
  const port = {
    loadCall: vi.fn(async () => (opts.call === undefined ? baseCall() : opts.call)),
    claimOrRecord: vi.fn(async (_id: string, next: { status: string }) => {
      if (status !== null) return false;
      status = next.status;
      return true;
    }),
    finalize: vi.fn(async (_id: string, patch: { status: string }) => {
      if (status === "claimed") status = patch.status;
    }),
    sendEmailStep: vi.fn(opts.step ?? (async () => stepResult())),
    now: () => NOW,
  } satisfies HandoffPort;
  return { port, status: () => status };
}

const consent = { sendPaymentLink: true };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("1. mode fence (fail closed)", () => {
  it.each([undefined, "", "LIVE", "Dry_Run", "garbage", "true"])("mode %j → OFF: no claim, no write, no send", async (raw) => {
    const { port } = fakePort();
    const r = await maybeSendVoiceHandoffEmail(
      { voiceCallId: CALL_ID, structuredData: consent, mode: parseHandoffMode(raw) },
      port,
    );
    expect(r).toEqual({ action: "off" });
    expect(port.loadCall).not.toHaveBeenCalled();
    expect(port.claimOrRecord).not.toHaveBeenCalled();
    expect(port.finalize).not.toHaveBeenCalled();
    expect(port.sendEmailStep).not.toHaveBeenCalled();
  });

  it("only exact 'dry_run' / 'live' enable it", () => {
    expect(parseHandoffMode("dry_run")).toBe("dry_run");
    expect(parseHandoffMode("live")).toBe("live");
  });
});

describe("2–5. send conditions → skipped (NULL-guarded record, never a send)", () => {
  async function run(call: HandoffCall, structuredData: unknown, clientFence?: string) {
    const f = fakePort({ call });
    const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData, mode: "live", clientFence }, f.port);
    expect(f.port.sendEmailStep).not.toHaveBeenCalled();
    return { r, f };
  }

  it("2. outcome != connected → not_connected", async () => {
    for (const outcome of ["voicemail", "no-answer", "busy", "failed", null]) {
      const { r, f } = await run(baseCall({ outcome }), consent);
      expect(r).toEqual({ action: "skipped", reason: "not_connected" });
      expect(f.port.claimOrRecord).toHaveBeenCalledWith(CALL_ID, { status: "skipped", reason: "not_connected" }, NOW);
      expect(f.status()).toBe("skipped");
    }
  });

  it("3. sendPaymentLink missing / false / \"true\" string → no_payment_link_consent", async () => {
    for (const sd of [undefined, {}, { sendPaymentLink: false }, { sendPaymentLink: "true" }, { sendPaymentLink: 1 }]) {
      const { r } = await run(baseCall(), sd);
      expect(r).toEqual({ action: "skipped", reason: "no_payment_link_consent" });
    }
  });

  it("4. invoice_id null → no_invoice; outstanding 0 → invoice_not_open", async () => {
    expect((await run(baseCall({ invoice_id: null, invoice_outstanding_cents: null }), consent)).r).toEqual({
      action: "skipped",
      reason: "no_invoice",
    });
    expect((await run(baseCall({ invoice_outstanding_cents: 0 }), consent)).r).toEqual({ action: "skipped", reason: "invoice_not_open" });
    expect((await run(baseCall({ invoice_outstanding_cents: null }), consent)).r).toEqual({ action: "skipped", reason: "invoice_not_open" });
  });

  it("5. client fence set + different client → client_fenced; same client passes", async () => {
    expect((await run(baseCall(), consent, "other-client")).r).toEqual({ action: "skipped", reason: "client_fenced" });
    const f = fakePort();
    const ok = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live", clientFence: CLIENT }, f.port);
    expect(ok.action).toBe("sent");
  });

  it("condition order: not_connected wins over missing consent and invoice", async () => {
    const { r } = await run(baseCall({ outcome: "voicemail", invoice_id: null }), {});
    expect(r).toEqual({ action: "skipped", reason: "not_connected" });
  });
});

describe("6–7. happy paths", () => {
  it("6. live → sendEmailStep exactly once with {subscriberId, clientId, invoiceId} + 'live'; finalized sent", async () => {
    const f = fakePort();
    const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(r).toEqual({ action: "sent", communicationId: "comm-1" });
    expect(f.port.claimOrRecord).toHaveBeenCalledWith(CALL_ID, { status: "claimed" }, NOW);
    expect(f.port.sendEmailStep).toHaveBeenCalledTimes(1);
    expect(f.port.sendEmailStep).toHaveBeenCalledWith({ subscriberId: SUB, clientId: CLIENT, invoiceId: INVOICE }, "live");
    expect(f.port.finalize).toHaveBeenCalledWith(CALL_ID, { status: "sent", reason: null, communicationId: "comm-1" });
    expect(f.status()).toBe("sent");
  });

  it("7. dry_run → called with 'dry_run'; finalized would_send", async () => {
    const f = fakePort({ step: async () => stepResult({ outcome: "would_send", mailersendMessageId: null }) });
    const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "dry_run" }, f.port);
    expect(r).toEqual({ action: "would_send", communicationId: "comm-1" });
    expect(f.port.sendEmailStep).toHaveBeenCalledWith({ subscriberId: SUB, clientId: CLIENT, invoiceId: INVOICE }, "dry_run");
    expect(f.port.finalize).toHaveBeenCalledWith(CALL_ID, { status: "would_send", reason: null, communicationId: "comm-1" });
  });
});

describe("8–9. at most once", () => {
  it("8. duplicate delivery: claim returns 0 rows → sendEmailStep never called", async () => {
    const f = fakePort();
    f.port.claimOrRecord.mockResolvedValueOnce(false);
    const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(r).toEqual({ action: "duplicate" });
    expect(f.port.sendEmailStep).not.toHaveBeenCalled();
    expect(f.port.finalize).not.toHaveBeenCalled();
  });

  it("8b. a replay after a completed send is a no-op", async () => {
    const f = fakePort();
    await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    const again = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(again).toEqual({ action: "duplicate" });
    expect(f.port.sendEmailStep).toHaveBeenCalledTimes(1);
  });

  it("8c. a replay after a skip can never send later", async () => {
    const f = fakePort();
    const first = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: {}, mode: "live" }, f.port);
    expect(first).toEqual({ action: "skipped", reason: "no_payment_link_consent" });
    const replay = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(replay).toEqual({ action: "duplicate" });
    expect(f.port.sendEmailStep).not.toHaveBeenCalled();
  });

  it("9. concurrency: two concurrent invocations, claim granted once → exactly one send", async () => {
    const f = fakePort({
      step: () => new Promise((resolve) => setTimeout(() => resolve(stepResult()), 5)),
    });
    const [a, b] = await Promise.all([
      maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port),
      maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port),
    ]);
    expect([a.action, b.action].sort()).toEqual(["duplicate", "sent"]);
    expect(f.port.sendEmailStep).toHaveBeenCalledTimes(1);
  });
});

describe("10–11. failures and gate outcomes", () => {
  it("10a. sendEmailStep returns send_failed → failed", async () => {
    const f = fakePort({ step: async () => stepResult({ outcome: "send_failed", mailersendMessageId: null }) });
    const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(r).toEqual({ action: "failed", reason: "send_failed", communicationId: "comm-1" });
    expect(f.port.finalize).toHaveBeenCalledWith(CALL_ID, { status: "failed", reason: "send_failed", communicationId: "comm-1" });
    expect(f.status()).toBe("failed");
  });

  it("10b. sendEmailStep throws → failed + reason (truncated to 500), function does not throw", async () => {
    const long = "x".repeat(900);
    const f = fakePort({ step: async () => { throw new Error(long); } });
    const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(r.action).toBe("failed");
    const patch = f.port.finalize.mock.calls[0][1] as { status: string; reason: string };
    expect(patch.status).toBe("failed");
    expect(patch.reason).toHaveLength(500);
  });

  it("10c. a failed call is terminal: a replay does not retry", async () => {
    const f = fakePort({ step: async () => stepResult({ outcome: "send_failed" }) });
    await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    const replay = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(replay).toEqual({ action: "duplicate" });
    expect(f.port.sendEmailStep).toHaveBeenCalledTimes(1);
  });

  it("10d. port errors (load/claim/finalize) → { action: 'error' }, never throws", async () => {
    const f = fakePort();
    f.port.loadCall.mockRejectedValueOnce(new Error("db down"));
    await expect(
      maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port),
    ).resolves.toEqual({ action: "error", reason: "db down" });
  });

  it.each(["no_primary_contact", "channel_denied", "no_template", "no_payment_link"] as const)(
    "11. gate outcome %s → skipped with that reason",
    async (outcome) => {
      const f = fakePort({ step: async () => stepResult({ outcome, communicationId: null, recoveryAttemptId: null, mailersendMessageId: null }) });
      const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
      expect(r).toEqual({ action: "skipped", reason: outcome, communicationId: null });
      expect(f.port.finalize).toHaveBeenCalledWith(CALL_ID, { status: "skipped", reason: outcome, communicationId: null });
    },
  );

  it("no call row → no_call, nothing written", async () => {
    const f = fakePort({ call: null });
    const r = await maybeSendVoiceHandoffEmail({ voiceCallId: CALL_ID, structuredData: consent, mode: "live" }, f.port);
    expect(r).toEqual({ action: "no_call" });
    expect(f.port.claimOrRecord).not.toHaveBeenCalled();
  });
});

describe("createHandoffPort — the DB-enforced claim", () => {
  function fakeDb(rowsReturned: number) {
    const calls: { op: string; args: unknown[] }[] = [];
    const b: Record<string, unknown> = {};
    for (const m of ["update", "eq", "is", "select"]) {
      b[m] = (...args: unknown[]) => {
        calls.push({ op: m, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: Array.from({ length: rowsReturned }, () => ({ id: CALL_ID })), error: null });
    return { db: { from: () => b } as never, calls };
  }

  it("claim is update … where id = ? AND handoff_email_status IS NULL; 1 row → true", async () => {
    const { db, calls } = fakeDb(1);
    const ok = await createHandoffPort(db).claimOrRecord(CALL_ID, { status: "claimed" }, NOW);
    expect(ok).toBe(true);
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({
      handoff_email_status: "claimed",
      handoff_email_reason: null,
      handoff_email_at: NOW,
    });
    expect(calls).toContainEqual({ op: "eq", args: ["id", CALL_ID] });
    expect(calls).toContainEqual({ op: "is", args: ["handoff_email_status", null] });
  });

  it("0 rows (already claimed/recorded) → false", async () => {
    const { db } = fakeDb(0);
    expect(await createHandoffPort(db).claimOrRecord(CALL_ID, { status: "skipped", reason: "no_invoice" }, NOW)).toBe(false);
  });

  it("finalize only moves a row that is still 'claimed'", async () => {
    const { db, calls } = fakeDb(1);
    await createHandoffPort(db).finalize(CALL_ID, { status: "sent", reason: null, communicationId: "comm-1" });
    expect(calls).toContainEqual({ op: "eq", args: ["handoff_email_status", "claimed"] });
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({
      handoff_email_status: "sent",
      handoff_email_reason: null,
      handoff_email_communication_id: "comm-1",
    });
  });
});

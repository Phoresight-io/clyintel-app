import { describe, it, expect, vi } from "vitest";
import {
  sendEmailStep,
  renderTemplate,
  renderHtmlBody,
  resolvePaymentLink,
  nextAttemptNumber,
  COMM_STATUS,
  type SendEmailPort,
  type RenderVars,
} from "./sendEmailStep";
import type { ContactRow } from "./selectRecipients";

const CTX = { subscriberId: "sub-1", clientId: "client-1", invoiceId: "inv-1" };

const contact = (over: Partial<ContactRow>): ContactRow => ({
  id: "c1",
  client_id: "client-1",
  email: "payer@example.com",
  phone: null,
  is_primary: true,
  role: null,
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

const template = {
  id: "tpl-1",
  subject: "Reminder: invoice {{invoice_number}} is past due",
  body: "Hi {{client_name}}, {{amount_due}} due {{due_date}}.",
} as never;

const vars: RenderVars = {
  client_name: "Acme",
  invoice_number: "INV-9",
  amount_due: "$100.00",
  due_date: "2026-06-01",
  invoice_date: "2026-05-01",
  subscriber_name: "Phoresight",
  payment_link: "https://buy.stripe.com/test_123",
};

// Fully-stubbed port; each op is a spy so we can assert what was/wasn't called.
function makePort(over: Partial<SendEmailPort> = {}): SendEmailPort {
  return {
    loadPrimaryContact: vi.fn(async () => contact({})),
    loadActiveSystemDefaultEmailTemplate: vi.fn(async () => template),
    loadRenderVars: vi.fn(async () => vars),
    loadExistingAttemptNumbers: vi.fn(async () => [] as number[]),
    insertPendingCommunication: vi.fn(async () => "comm-1"),
    finalizeCommunication: vi.fn(async () => {}),
    insertRecoveryAttempt: vi.fn(async () => "ra-1"),
    dispatchEmail: vi.fn(async () => ({ messageId: "ms-123" })),
    now: () => "2026-07-04T00:00:00.000Z",
    ...over,
  };
}

describe("renderTemplate", () => {
  it("substitutes known vars and leaves unknown tokens intact", () => {
    expect(renderTemplate("Hi {{client_name}} / {{unknown}}", vars)).toBe("Hi Acme / {{unknown}}");
  });
});

describe("resolvePaymentLink", () => {
  it("prefers the client link, then subscriber link, else null", () => {
    expect(resolvePaymentLink("https://c", "https://s")).toBe("https://c");
    expect(resolvePaymentLink("", "https://s")).toBe("https://s");
    expect(resolvePaymentLink("  ", "https://s")).toBe("https://s"); // whitespace = absent
    expect(resolvePaymentLink(null, null)).toBeNull();
    expect(resolvePaymentLink(undefined, "")).toBeNull();
  });
});

describe("renderHtmlBody", () => {
  it("escapes values, renders payment_link as an anchor, and \\n → <br>", () => {
    const html = renderHtmlBody("Hi {{client_name}}\nPay: {{payment_link}}", {
      ...vars,
      client_name: "A & <b>Co</b>",
      payment_link: "https://pay/?a=1&b=2",
    });
    expect(html).toBe(
      'Hi A &amp; &lt;b&gt;Co&lt;/b&gt;<br>Pay: ' +
        '<a href="https://pay/?a=1&amp;b=2">https://pay/?a=1&amp;b=2</a>',
    );
  });

  it("leaves unknown tokens as escaped literals", () => {
    expect(renderHtmlBody("x {{nope}}", vars)).toBe("x {{nope}}");
  });
});

describe("nextAttemptNumber", () => {
  it("is 1 with no prior attempts, else max+1 (incl. a simulation row)", () => {
    expect(nextAttemptNumber([])).toBe(1);
    expect(nextAttemptNumber([1])).toBe(2); // a SIMULATION row is attempt 1 → real is 2
    expect(nextAttemptNumber([1, 3, 2])).toBe(4);
  });
});

describe("sendEmailStep — gating", () => {
  it("email-less client (no primary) → clean no-op, nothing written", async () => {
    const port = makePort({ loadPrimaryContact: vi.fn(async () => null) });
    const res = await sendEmailStep(CTX, "dry_run", port);
    expect(res.outcome).toBe("no_primary_contact");
    expect(port.insertPendingCommunication).not.toHaveBeenCalled();
    expect(port.dispatchEmail).not.toHaveBeenCalled();
    expect(port.insertRecoveryAttempt).not.toHaveBeenCalled();
  });

  it("opt-out gate denied → no communications row, no send", async () => {
    const port = makePort({ loadPrimaryContact: vi.fn(async () => contact({ opt_out_email: true })) });
    const res = await sendEmailStep(CTX, "dry_run", port);
    expect(res.outcome).toBe("channel_denied");
    expect(port.insertPendingCommunication).not.toHaveBeenCalled();
    expect(port.dispatchEmail).not.toHaveBeenCalled();
  });

  it("missing template → no write, no send", async () => {
    const port = makePort({ loadActiveSystemDefaultEmailTemplate: vi.fn(async () => null) });
    const res = await sendEmailStep(CTX, "dry_run", port);
    expect(res.outcome).toBe("no_template");
    expect(port.insertPendingCommunication).not.toHaveBeenCalled();
  });

  it("no resolvable payment link → suppressed, nothing written, no send", async () => {
    const port = makePort({
      loadRenderVars: vi.fn(async () => ({ ...vars, payment_link: "" })),
    });
    const res = await sendEmailStep(CTX, "dry_run", port);
    expect(res.outcome).toBe("no_payment_link");
    expect(port.insertPendingCommunication).not.toHaveBeenCalled();
    expect(port.dispatchEmail).not.toHaveBeenCalled();
    expect(port.insertRecoveryAttempt).not.toHaveBeenCalled();
  });
});

describe("sendEmailStep — dry-run", () => {
  it("writes the record but never calls MailerSend; message-id null; would_send + scheduled", async () => {
    const port = makePort();
    const res = await sendEmailStep(CTX, "dry_run", port);

    expect(port.dispatchEmail).not.toHaveBeenCalled(); // core dry-run guarantee
    expect(port.insertPendingCommunication).toHaveBeenCalledOnce();
    expect(port.finalizeCommunication).toHaveBeenCalledWith("comm-1", {
      status: COMM_STATUS.wouldSend,
      mailersend_message_id: null,
      sent_at: null,
    });
    expect(port.insertRecoveryAttempt).toHaveBeenCalledOnce();
    const raArg = (port.insertRecoveryAttempt as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { status: string; communication_id: string; sent_at: string | null; attempt_number: number };
    expect(raArg.status).toBe("scheduled");
    expect(raArg.communication_id).toBe("comm-1");
    expect(raArg.sent_at).toBeNull();
    expect(raArg.attempt_number).toBe(1);
    expect(res).toEqual({
      outcome: "would_send",
      communicationId: "comm-1",
      recoveryAttemptId: "ra-1",
      mailersendMessageId: null,
    });
  });
});

describe("sendEmailStep — live", () => {
  it("calls MailerSend, persists message-id, status sent + recovery sent", async () => {
    const port = makePort({ loadExistingAttemptNumbers: vi.fn(async () => [1]) }); // prior sim row
    const res = await sendEmailStep(CTX, "live", port);

    expect(port.dispatchEmail).toHaveBeenCalledOnce();
    expect(port.finalizeCommunication).toHaveBeenCalledWith("comm-1", {
      status: COMM_STATUS.sent,
      mailersend_message_id: "ms-123",
      sent_at: "2026-07-04T00:00:00.000Z",
    });
    const raArg = (port.insertRecoveryAttempt as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { status: string; sent_at: string | null; attempt_number: number };
    expect(raArg.status).toBe("sent");
    expect(raArg.sent_at).toBe("2026-07-04T00:00:00.000Z");
    expect(raArg.attempt_number).toBe(2); // one past the simulation row
    expect(res.outcome).toBe("sent");
    expect(res.mailersendMessageId).toBe("ms-123");
  });

  it("live send failure → communications failed, recovery scheduled, no throw", async () => {
    const port = makePort({
      dispatchEmail: vi.fn(async () => {
        throw new Error("MailerSend 422");
      }),
    });
    const res = await sendEmailStep(CTX, "live", port);
    expect(res.outcome).toBe("send_failed");
    expect(port.finalizeCommunication).toHaveBeenCalledWith("comm-1", {
      status: COMM_STATUS.failed,
      mailersend_message_id: null,
      sent_at: null,
    });
    const raArg = (port.insertRecoveryAttempt as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { status: string };
    expect(raArg.status).toBe("scheduled");
  });
});

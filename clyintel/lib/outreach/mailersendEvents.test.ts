import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  verifyMailersendSignature,
  extractMessageId,
  extractEventType,
  classifyMailersendEvent,
  escalateAttention,
} from "./mailersendEvents";
import { ATTENTION_REASON } from "./deriveAttentionReason";

const SECRET = "whsec_test_secret";

function sign(rawBody: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

describe("verifyMailersendSignature", () => {
  const body = JSON.stringify({ type: "activity.hard_bounced" });

  it("accepts a correct HMAC-SHA256 signature over the raw body", () => {
    expect(verifyMailersendSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyMailersendSignature(body, sign(body, "other"), SECRET)).toBe(false);
  });

  it("rejects when the body is tampered after signing", () => {
    const sig = sign(body);
    expect(verifyMailersendSignature(body + " ", sig, SECRET)).toBe(false);
  });

  it("rejects a missing (null) signature header — fail-closed", () => {
    expect(verifyMailersendSignature(body, null, SECRET)).toBe(false);
  });

  it("rejects a malformed (non-hex / wrong-length) signature header", () => {
    expect(verifyMailersendSignature(body, "not-hex-zz", SECRET)).toBe(false);
    expect(verifyMailersendSignature(body, "abcd", SECRET)).toBe(false);
  });
});

describe("extractMessageId", () => {
  it("reads data.email.message.id (the X-Message-Id that matches communications)", () => {
    const p = { data: { email: { message: { id: "ms-abc" } } } };
    expect(extractMessageId(p)).toBe("ms-abc");
  });

  it("falls back to data.email.id when message.id is absent", () => {
    expect(extractMessageId({ data: { email: { id: "ms-fallback" } } })).toBe("ms-fallback");
  });

  it("returns null when no message id is present", () => {
    expect(extractMessageId({ data: { email: {} } })).toBeNull();
    expect(extractMessageId({})).toBeNull();
    expect(extractMessageId(null)).toBeNull();
  });
});

describe("extractEventType", () => {
  it("reads the top-level type, then data.type", () => {
    expect(extractEventType({ type: "activity.hard_bounced" })).toBe("activity.hard_bounced");
    expect(extractEventType({ data: { type: "spam_complaint" } })).toBe("spam_complaint");
    expect(extractEventType({})).toBe("");
  });
});

describe("classifyMailersendEvent", () => {
  it("spam complaint → opt-out + attention(spam_complaint)", () => {
    expect(classifyMailersendEvent("activity.spam_complaint")).toEqual({
      optOutEmail: true,
      attentionEvent: "spam_complaint",
      activity: false,
    });
  });

  it("unsubscribe → opt-out + attention(opt_out)", () => {
    expect(classifyMailersendEvent("activity.unsubscribed")).toEqual({
      optOutEmail: true,
      attentionEvent: "opt_out",
      activity: false,
    });
  });

  it("hard bounce → attention(hard_bounce) ONLY, never opt-out", () => {
    expect(classifyMailersendEvent("activity.hard_bounced")).toEqual({
      optOutEmail: false,
      attentionEvent: "hard_bounce",
      activity: false,
    });
  });

  it("soft bounce → ignored (no opt-out, no attention, not activity)", () => {
    expect(classifyMailersendEvent("activity.soft_bounced")).toEqual({
      optOutEmail: false,
      attentionEvent: null,
      activity: false,
    });
  });

  it("delivered / opened / clicked / sent → activity only, never opt-out", () => {
    for (const t of ["activity.delivered", "activity.opened", "activity.clicked", "activity.sent"]) {
      expect(classifyMailersendEvent(t)).toEqual({
        optOutEmail: false,
        attentionEvent: null,
        activity: true,
      });
    }
  });

  it("unknown event → no-op", () => {
    expect(classifyMailersendEvent("activity.queued")).toEqual({
      optOutEmail: false,
      attentionEvent: null,
      activity: false,
    });
  });
});

describe("escalateAttention — severity-monotonic, null-safe", () => {
  it("null current → derives from the incoming event alone (no phantom prior, no crash)", () => {
    expect(escalateAttention(null, "hard_bounce")).toBe(ATTENTION_REASON.hard_bounce);
    expect(escalateAttention(null, "opt_out")).toBe(ATTENTION_REASON.opt_out);
    expect(escalateAttention(null, "spam_complaint")).toBe(ATTENTION_REASON.spam_complaint);
  });

  it("escalates upward (opt_out then hard_bounce → hard_bounce)", () => {
    expect(escalateAttention(ATTENTION_REASON.opt_out, "hard_bounce")).toBe(
      ATTENTION_REASON.hard_bounce,
    );
  });

  it("never downgrades: existing spam_complaint + incoming hard_bounce → stays spam_complaint", () => {
    expect(escalateAttention(ATTENTION_REASON.spam_complaint, "hard_bounce")).toBe(
      ATTENTION_REASON.spam_complaint,
    );
  });

  it("never downgrades: existing hard_bounce + incoming opt_out → stays hard_bounce", () => {
    expect(escalateAttention(ATTENTION_REASON.hard_bounce, "opt_out")).toBe(
      ATTENTION_REASON.hard_bounce,
    );
  });

  it("an unrecognized current reason contributes no phantom prior event", () => {
    // Garbage current → treated as if null; result is the incoming event's reason.
    expect(escalateAttention("some_legacy_value", "opt_out")).toBe(ATTENTION_REASON.opt_out);
  });

  it("idempotent: same reason in and out (spam_complaint + spam_complaint)", () => {
    expect(escalateAttention(ATTENTION_REASON.spam_complaint, "spam_complaint")).toBe(
      ATTENTION_REASON.spam_complaint,
    );
  });
});

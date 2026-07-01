import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { classifyWebhookRequest } from "./classifyWebhookRequest";

// Same deterministic recipe the verifier + Intuit use: base64 HMAC-SHA256.
const TOKEN = "test-verifier-token-abc123";
const BODY = JSON.stringify({
  eventNotifications: [
    { realmId: "9130347597", dataChangeEvent: { entities: [{ name: "Payment", id: "42" }] } },
  ],
});
const sign = (body: string, token: string): string =>
  createHmac("sha256", token).update(body, "utf8").digest("base64");
const VALID_SIGNATURE = sign(BODY, TOKEN);

describe("classifyWebhookRequest", () => {
  it("valid signature + parseable body → accepted with parsed payload", () => {
    const out = classifyWebhookRequest(BODY, VALID_SIGNATURE, TOKEN);
    expect(out.kind).toBe("accepted");
    if (out.kind === "accepted") {
      expect(out.payload).toEqual(JSON.parse(BODY));
    }
  });

  it("missing/empty verifier token → misconfigured (never skips verification)", () => {
    expect(classifyWebhookRequest(BODY, VALID_SIGNATURE, undefined).kind).toBe("misconfigured");
    expect(classifyWebhookRequest(BODY, VALID_SIGNATURE, null).kind).toBe("misconfigured");
    expect(classifyWebhookRequest(BODY, VALID_SIGNATURE, "").kind).toBe("misconfigured");
  });

  it("bad signature → unauthorized, no payload", () => {
    expect(classifyWebhookRequest(BODY, "not-the-signature", TOKEN).kind).toBe("unauthorized");
    // Tampered body against a valid-for-original signature.
    const tampered = BODY.replace('"id":"42"', '"id":"43"');
    expect(classifyWebhookRequest(tampered, VALID_SIGNATURE, TOKEN).kind).toBe("unauthorized");
  });

  it("missing signature header → unauthorized", () => {
    expect(classifyWebhookRequest(BODY, null, TOKEN).kind).toBe("unauthorized");
    expect(classifyWebhookRequest(BODY, undefined, TOKEN).kind).toBe("unauthorized");
  });

  it("verified but non-JSON body → malformed (verification checked first)", () => {
    const notJson = "this is not json {";
    const sig = sign(notJson, TOKEN); // legitimately signed, but unparseable
    expect(classifyWebhookRequest(notJson, sig, TOKEN).kind).toBe("malformed");
  });

  it("orders checks: token before signature before parse", () => {
    // No token → misconfigured even though signature would be invalid and body unparseable.
    expect(classifyWebhookRequest("{", "x", "").kind).toBe("misconfigured");
    // Bad signature on an unparseable body → unauthorized (parse never reached).
    expect(classifyWebhookRequest("{", "wrong", TOKEN).kind).toBe("unauthorized");
  });
});

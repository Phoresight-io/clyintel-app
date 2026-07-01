import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "./verifyWebhookSignature";

// Deterministic fixtures — no env, no network. The expected signature is
// derived with the same recipe the verifier uses (base64 HMAC-SHA256).
const TOKEN = "test-verifier-token-abc123";
const BODY = JSON.stringify({
  eventNotifications: [
    {
      realmId: "9130347597",
      dataChangeEvent: {
        entities: [{ name: "Payment", id: "42", operation: "Create" }],
      },
    },
  ],
});

const sign = (body: string, token: string): string =>
  createHmac("sha256", token).update(body, "utf8").digest("base64");

const VALID_SIGNATURE = sign(BODY, TOKEN);

describe("verifyWebhookSignature", () => {
  it("1. valid signature passes", () => {
    expect(verifyWebhookSignature(BODY, VALID_SIGNATURE, TOKEN)).toBe(true);
  });

  it("2. tampered body fails", () => {
    const tampered = BODY.replace('"id":"42"', '"id":"43"');
    expect(tampered).not.toBe(BODY);
    expect(verifyWebhookSignature(tampered, VALID_SIGNATURE, TOKEN)).toBe(false);
  });

  it("3. wrong verifier token fails", () => {
    expect(verifyWebhookSignature(BODY, VALID_SIGNATURE, "different-token")).toBe(false);
  });

  it("4. missing/empty header fails without throwing", () => {
    expect(() => verifyWebhookSignature(BODY, null, TOKEN)).not.toThrow();
    expect(verifyWebhookSignature(BODY, null, TOKEN)).toBe(false);
    expect(verifyWebhookSignature(BODY, undefined, TOKEN)).toBe(false);
    expect(verifyWebhookSignature(BODY, "", TOKEN)).toBe(false);
  });

  it("5. length-mismatch header fails without throwing (length guard)", () => {
    const short = "abc";
    expect(short.length).not.toBe(VALID_SIGNATURE.length);
    expect(() => verifyWebhookSignature(BODY, short, TOKEN)).not.toThrow();
    expect(verifyWebhookSignature(BODY, short, TOKEN)).toBe(false);
  });
});

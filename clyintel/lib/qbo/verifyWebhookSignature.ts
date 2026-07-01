import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify an Intuit QBO webhook signature.
 *
 * Intuit signs each webhook with the verifier token: the `intuit-signature`
 * header is base64( HMAC-SHA256( rawRequestBody, verifierToken ) ). The caller
 * extracts the raw body (e.g. `await req.text()`) — this function performs no
 * I/O and reads no env; the token is injected. Never throws on a malformed or
 * missing header and never logs the token or signatures.
 *
 * @param rawBody          the exact raw request body bytes as a string
 * @param signatureHeader  value of the `intuit-signature` header (base64 HMAC-SHA256)
 * @param verifierToken    the Intuit webhook verifier token (QBO_WEBHOOK_VERIFIER_TOKEN)
 * @returns true iff the signature is valid
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  verifierToken: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", verifierToken)
    .update(rawBody, "utf8")
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false; // length guard before timingSafeEqual
  return timingSafeEqual(a, b);
}

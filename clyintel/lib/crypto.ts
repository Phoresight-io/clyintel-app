import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Canonical at-rest secret encryption for the repo (AES-256-GCM). Any future
// per-row secret (OAuth tokens, API keys, webhook signing secrets, …) MUST reuse
// encryptSecret / decryptSecret rather than rolling its own crypto.
//
// The key never appears in code. It is read from TOKEN_ENCRYPTION_KEY (32 raw
// bytes, base64-encoded) at call time — mirroring the getSupabase() "never
// silently degrade" pattern: a missing/invalid key throws a clear error rather
// than falling back to plaintext.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set — at-rest secret encryption cannot proceed"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}) — generate with: openssl rand -base64 32`
    );
  }
  return key;
}

/**
 * Encrypt a UTF-8 secret. Returns a single self-describing string:
 *   base64(iv).base64(authTag).base64(ciphertext)
 * A fresh random 12-byte IV is generated per call, so encrypting the same
 * plaintext twice yields different payloads.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a payload produced by encryptSecret. Throws if the payload is
 * malformed or if the auth tag fails verification (tampering / wrong key).
 */
export function decryptSecret(payload: string): string {
  const key = getKey();
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted payload — expected iv.authTag.ciphertext");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

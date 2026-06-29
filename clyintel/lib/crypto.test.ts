import { describe, it, expect, beforeAll, afterAll } from "vitest";

// 32-byte key, base64-encoded (deterministic for the test run).
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
});

describe("crypto: encryptSecret / decryptSecret", () => {
  it("round-trips a variety of plaintexts", async () => {
    const { encryptSecret, decryptSecret } = await import("./crypto");
    for (const plain of ["hello", "", "a refresh_token.with.dots", "🔐 unicode", "x".repeat(2000)]) {
      expect(decryptSecret(encryptSecret(plain))).toBe(plain);
    }
  });

  it("produces a fresh IV each call (same plaintext → different payloads)", async () => {
    const { encryptSecret, decryptSecret } = await import("./crypto");
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("self-describing format is iv.authTag.ciphertext (3 base64 parts)", async () => {
    const { encryptSecret } = await import("./crypto");
    const parts = encryptSecret("payload").split(".");
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(p).toMatch(/^[A-Za-z0-9+/]*={0,2}$/));
  });

  it("throws on a tampered ciphertext (GCM auth tag fails)", async () => {
    const { encryptSecret, decryptSecret } = await import("./crypto");
    const payload = encryptSecret("sensitive");
    const [iv, tag, data] = payload.split(".");
    // Flip the first byte of the ciphertext.
    const buf = Buffer.from(data, "base64");
    buf[0] ^= 0xff;
    const tampered = [iv, tag, buf.toString("base64")].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws on a malformed payload (wrong part count)", async () => {
    const { decryptSecret } = await import("./crypto");
    expect(() => decryptSecret("not-a-valid-payload")).toThrow(/Malformed/);
  });

  it("throws when TOKEN_ENCRYPTION_KEY is missing", async () => {
    const { encryptSecret } = await import("./crypto");
    const saved = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      expect(() => encryptSecret("x")).toThrow(/TOKEN_ENCRYPTION_KEY is not set/);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = saved;
    }
  });

  it("throws when the key is the wrong length", async () => {
    const { encryptSecret } = await import("./crypto");
    const saved = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64"); // 16 bytes, not 32
    try {
      expect(() => encryptSecret("x")).toThrow(/must decode to 32 bytes/);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = saved;
    }
  });
});

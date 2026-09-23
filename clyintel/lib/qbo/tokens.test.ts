import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the collaborators around the token lifecycle. `./constants` is PARTIALLY
// mocked so the real QboTokenError class is preserved (tokens.ts branches on
// `err instanceof QboTokenError` + `.oauthError`) while requestQboToken is stubbed.
vi.mock("@/lib/supabase", () => ({ getSupabase: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));
vi.mock("./constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./constants")>();
  return { ...actual, requestQboToken: vi.fn() };
});

import {
  getValidAccessToken,
  refreshAccessToken,
  QboReconnectRequiredError,
  QboTransientTokenError,
} from "./tokens";
import { getSupabase } from "@/lib/supabase";
import { requestQboToken, QboTokenError, type QboTokenResponse } from "./constants";

const SUB = "sub_1";
const REALM = "realm_1";
const PAST = "2020-01-01T00:00:00.000Z"; // forces the refresh path
const FUTURE = "2999-01-01T00:00:00.000Z"; // comfortably valid → no refresh

/** connected_accounts row shape getValidAccessToken/refreshAccessToken read. */
const ROW = {
  external_id: REALM,
  access_token: "current-access-token",
  refresh_token: "current-refresh-token",
  token_expires_at: PAST,
  meta: { refresh_expires_at: "2026-01-01T00:00:00.000Z" },
};

/**
 * Minimal Supabase stub for the connected_accounts read + update. The read chain
 * `.select().eq().eq().maybeSingle()` resolves to the provided row; every
 * `.update(payload)` is recorded (so tests can assert whether — and with what —
 * disconnected_at was written) and its `.eq().eq()` chain resolves to
 * `{ error }`.
 */
function makeService(
  row: unknown,
  opts?: { updateError?: { message: string } | null },
) {
  const updateCalls: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(() => Promise.resolve({ data: row, error: null }));
  builder.update = vi.fn((payload: Record<string, unknown>) => {
    updateCalls.push(payload);
    const updChain: Record<string, unknown> = {};
    updChain.eq = vi.fn(() => updChain);
    updChain.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({ error: opts?.updateError ?? null }).then(onF, onR);
    return updChain;
  });
  const from = vi.fn(() => builder);
  return { service: { from } as never, updateCalls };
}

const TOKEN_RESPONSE: QboTokenResponse = {
  access_token: "new-access-token",
  refresh_token: "new-refresh-token",
  expires_in: 3600,
  x_refresh_token_expires_in: 8640000,
  token_type: "bearer",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getValidAccessToken", () => {
  it("token comfortably valid → returns current token, no refresh call", async () => {
    const { service, updateCalls } = makeService({ ...ROW, token_expires_at: FUTURE });
    vi.mocked(getSupabase).mockReturnValue(service);

    const result = await getValidAccessToken(SUB);

    expect(result).toEqual({ accessToken: "current-access-token", realmId: REALM });
    expect(requestQboToken).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it("refresh returns invalid_grant → sets disconnected_at + throws QboReconnectRequiredError", async () => {
    const { service, updateCalls } = makeService(ROW);
    vi.mocked(getSupabase).mockReturnValue(service);
    vi.mocked(requestQboToken).mockRejectedValue(
      new QboTokenError(400, "invalid_grant", '{"error":"invalid_grant"}'),
    );

    const err = await getValidAccessToken(SUB).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QboReconnectRequiredError);
    expect((err as QboReconnectRequiredError).oauthError).toBe("invalid_grant");
    // The connection was flagged needs-reconnect (disconnected_at set), and no
    // token-persist update happened (the refresh failed before rotation).
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].disconnected_at).toEqual(expect.any(String));
    expect(updateCalls[0]).not.toHaveProperty("access_token");
  });

  it("refresh returns 500 → throws transient error, does NOT set disconnected_at", async () => {
    const { service, updateCalls } = makeService(ROW);
    vi.mocked(getSupabase).mockReturnValue(service);
    vi.mocked(requestQboToken).mockRejectedValue(
      new QboTokenError(500, null, "Internal Server Error"),
    );

    const err = await getValidAccessToken(SUB).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QboTransientTokenError);
    // Connection left untouched → safe to retry.
    expect(updateCalls).toHaveLength(0);
  });

  it("network/unparseable failure (non-QboTokenError) → transient, connection untouched", async () => {
    const { service, updateCalls } = makeService(ROW);
    vi.mocked(getSupabase).mockReturnValue(service);
    vi.mocked(requestQboToken).mockRejectedValue(new Error("ECONNRESET"));

    const err = await getValidAccessToken(SUB).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QboTransientTokenError);
    expect(updateCalls).toHaveLength(0);
  });

  it("refresh succeeds → persists rotated tokens and returns the new access token", async () => {
    const { service, updateCalls } = makeService(ROW);
    vi.mocked(getSupabase).mockReturnValue(service);
    vi.mocked(requestQboToken).mockResolvedValue(TOKEN_RESPONSE);

    const result = await getValidAccessToken(SUB);

    expect(result).toEqual({ accessToken: "new-access-token", realmId: REALM });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].access_token).toBe("new-access-token"); // crypto mocked to identity
    expect(updateCalls[0].refresh_token).toBe("new-refresh-token");
    expect(updateCalls[0]).not.toHaveProperty("disconnected_at");
  });
});

describe("refreshAccessToken (force refresh, ignores clock skew)", () => {
  it("refreshes even when the token is comfortably valid", async () => {
    const { service, updateCalls } = makeService({ ...ROW, token_expires_at: FUTURE });
    vi.mocked(getSupabase).mockReturnValue(service);
    vi.mocked(requestQboToken).mockResolvedValue(TOKEN_RESPONSE);

    const result = await refreshAccessToken(SUB);

    expect(requestQboToken).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accessToken: "new-access-token", realmId: REALM });
    expect(updateCalls).toHaveLength(1);
  });

  it("invalid_grant → sets disconnected_at + throws QboReconnectRequiredError", async () => {
    const { service, updateCalls } = makeService(ROW);
    vi.mocked(getSupabase).mockReturnValue(service);
    vi.mocked(requestQboToken).mockRejectedValue(
      new QboTokenError(400, "invalid_grant", '{"error":"invalid_grant"}'),
    );

    const err = await refreshAccessToken(SUB).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QboReconnectRequiredError);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].disconnected_at).toEqual(expect.any(String));
  });
});

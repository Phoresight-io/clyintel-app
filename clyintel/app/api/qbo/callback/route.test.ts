import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// This suite tests the CALLBACK ROUTE's failure handling — specifically that a
// token-exchange throw (now a typed QboTokenError) still lands on the graceful
// finish("error") redirect rather than an unhandled 500. Collaborators are
// mocked so the test drives the code straight to the exchange and back.
//
// State validation is stubbed to PASS (its own logic is covered by
// oauthState-focused tests); we only care about the exchange catch here.
vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServer: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "sub_1" } } }) },
  })),
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: vi.fn() }));
vi.mock("@/lib/qbo/runQboSync", () => ({ runQboSync: vi.fn() }));
vi.mock("@/lib/qbo/tokens", () => ({ exchangeAuthCode: vi.fn() }));
vi.mock("@/lib/qbo/oauthState", () => ({
  QBO_STATE_COOKIE: "qbo_oauth_state",
  DEFAULT_RETURN_TO: "/connections",
  isStateValid: vi.fn(() => true),
  parseStateCookie: vi.fn(() => ({ state: "s", subscriberId: "sub_1", exp: Date.now() + 1e6 })),
  sanitizeReturnTo: vi.fn(() => "/connections"),
}));

import { GET } from "./route";
import { exchangeAuthCode } from "@/lib/qbo/tokens";
import { runQboSync } from "@/lib/qbo/runQboSync";
import { QboTokenError } from "@/lib/qbo/constants";

const ORIGIN = "https://app.example.com";

/**
 * Minimal NextRequest stub: the callback reads only `req.nextUrl.searchParams`,
 * `req.nextUrl.origin`, and `req.cookies.get()`. A valid state cookie value is
 * present (isStateValid is stubbed to accept it).
 */
function makeReq(params: Record<string, string>): never {
  const searchParams = new URLSearchParams(params);
  return {
    nextUrl: { searchParams, origin: ORIGIN },
    cookies: { get: (_name: string) => ({ value: "sealed-state-cookie" }) },
  } as never;
}

const ORIGINAL_REDIRECT_URI = process.env.QBO_REDIRECT_URI;

beforeEach(() => {
  vi.clearAllMocks();
  // Must be set so the route passes its redirect_uri guard and reaches the
  // exchange (otherwise it would finish("error") for a different reason).
  process.env.QBO_REDIRECT_URI = "https://app.example.com/api/qbo/callback";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_REDIRECT_URI === undefined) delete process.env.QBO_REDIRECT_URI;
  else process.env.QBO_REDIRECT_URI = ORIGINAL_REDIRECT_URI;
  vi.restoreAllMocks();
});

describe("qbo/callback — token-exchange failure lands on finish('error')", () => {
  it("exchange throws QboTokenError (bad/expired code) → 303 redirect to /connections?qbo=error, sync not run", async () => {
    vi.mocked(exchangeAuthCode).mockRejectedValue(
      new QboTokenError(400, "invalid_grant", '{"error":"invalid_grant"}'),
    );

    const res = await GET(makeReq({ code: "expired_code", realmId: "9130347597", state: "s" }));

    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`${ORIGIN}/connections?qbo=error`);
    // Reached the exchange, and did NOT proceed to persist/sync on failure.
    expect(exchangeAuthCode).toHaveBeenCalledTimes(1);
    expect(runQboSync).not.toHaveBeenCalled();
    // Single-use state cookie is cleared on the way out.
    expect(res.cookies.get("qbo_oauth_state")?.value).toBe("");
  });

  it("exchange throws a plain Error → also 303 /connections?qbo=error (type-agnostic catch)", async () => {
    vi.mocked(exchangeAuthCode).mockRejectedValue(new Error("network down"));

    const res = await GET(makeReq({ code: "abc", realmId: "9130347597", state: "s" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/connections?qbo=error`);
    expect(runQboSync).not.toHaveBeenCalled();
  });
});

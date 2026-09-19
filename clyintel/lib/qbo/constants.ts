// Intuit QuickBooks Online OAuth2 constants. The authorize/token endpoints are
// environment-independent for OAuth (sandbox vs production is selected by the
// app credentials and QBO_ENVIRONMENT, not by a different OAuth host).

import { serverEnv } from "@/lib/config/env.server";

export const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

/**
 * Base host for the QBO Accounting API (`/v3/company/...`). Unlike the OAuth
 * hosts above, this IS environment-specific (sandbox vs production), so it is
 * env-derived via `QBO_BASE_URL` — never hardcoded. Set to
 * `https://quickbooks.api.intuit.com` in production and
 * `https://sandbox-quickbooks.api.intuit.com` in sandbox. Throws if unset (a
 * missing base must surface, not silently default to the wrong environment).
 */
export function qboApiBaseUrl(): string {
  // Required — throws a clear, var-named error if unset (never silently defaults
  // to the wrong environment). Trailing-slash normalization stays here.
  return serverEnv.qboBaseUrl().replace(/\/+$/, ""); // tolerate a trailing slash
}

export interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

/**
 * Typed error for a non-2xx from the Intuit token endpoint. Carries the HTTP
 * `status` and, when the body parses as an OAuth error JSON
 * (`{"error":"invalid_grant",...}`), the machine-readable `oauthError` code so
 * callers can branch on it — notably the refresh path in tokens.ts, which flags
 * a connection needs-reconnect ONLY on `invalid_grant` and treats everything
 * else as transient. `oauthError` is null when the body is absent or not JSON.
 *
 * The human-readable `message` is byte-for-byte what the pre-typed error threw
 * (`Intuit token request failed (<status>): <detail>`), so existing logs and the
 * OAuth callback's generic catch (`finish("error")`) are unaffected — a subclass
 * of Error still satisfies every `instanceof Error` / message check. The body
 * text never contains our tokens (only the server's error description), so it is
 * safe to surface.
 */
export class QboTokenError extends Error {
  readonly status: number;
  readonly oauthError: string | null;
  readonly detail: string;
  constructor(status: number, oauthError: string | null, detail: string) {
    super(`Intuit token request failed (${status}): ${detail}`);
    this.name = "QboTokenError";
    this.status = status;
    this.oauthError = oauthError;
    this.detail = detail;
  }
}

function basicAuthHeader(): string {
  // Both required — each throws a clear, var-named error if unset.
  const id = serverEnv.qboClientId();
  const secret = serverEnv.qboClientSecret();
  return Buffer.from(`${id}:${secret}`).toString("base64");
}

/**
 * POST to the Intuit token endpoint with HTTP Basic auth and a
 * url-encoded body. Used for both the authorization_code exchange and
 * refresh_token rotation. Throws (never logs token values) on a non-2xx.
 */
export async function requestQboToken(body: URLSearchParams): Promise<QboTokenResponse> {
  const res = await fetch(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuthHeader()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // Body may contain an error description but never our tokens — safe to surface.
    const detail = await res.text().catch(() => "");
    // Intuit returns an OAuth error JSON (e.g. {"error":"invalid_grant"}) on token
    // failures. Best-effort parse to expose the machine-readable code; a missing
    // or non-JSON body leaves oauthError null (the caller treats null as a
    // generic/transient failure, never as a dead refresh token).
    let oauthError: string | null = null;
    try {
      const parsed = JSON.parse(detail) as { error?: unknown };
      if (typeof parsed.error === "string") oauthError = parsed.error;
    } catch {
      // Non-JSON body → leave oauthError null.
    }
    throw new QboTokenError(res.status, oauthError, detail);
  }
  return (await res.json()) as QboTokenResponse;
}

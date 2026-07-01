// Intuit QuickBooks Online OAuth2 constants. The authorize/token endpoints are
// environment-independent for OAuth (sandbox vs production is selected by the
// app credentials and QBO_ENVIRONMENT, not by a different OAuth host).

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
  const base = process.env.QBO_BASE_URL;
  if (!base) {
    throw new Error("QBO_BASE_URL is not set");
  }
  return base.replace(/\/+$/, ""); // tolerate a trailing slash
}

export interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

function basicAuthHeader(): string {
  const id = process.env.QBO_CLIENT_ID;
  const secret = process.env.QBO_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("QBO_CLIENT_ID / QBO_CLIENT_SECRET are not set");
  }
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
    throw new Error(`Intuit token request failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as QboTokenResponse;
}

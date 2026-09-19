import { getSupabase } from "@/lib/supabase";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { requestQboToken, QboTokenError, type QboTokenResponse } from "./constants";

// QuickBooks token lifecycle helpers. All persistence goes through encryptSecret;
// all reads through decryptSecret. Never log token values.

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh when within 5 min of expiry

/**
 * The QBO refresh token itself was rejected by Intuit (`invalid_grant`): it has
 * expired (the ~100-day inactivity limit) or been revoked. Before this is thrown
 * the connection is flagged needs-reconnect (connected_accounts.disconnected_at
 * set) so the UI can prompt re-authorization. NOT safe to retry — the grant is
 * dead until the subscriber reconnects.
 */
export class QboReconnectRequiredError extends Error {
  readonly oauthError: string;
  constructor(subscriberId: string, oauthError: string) {
    super(
      `QuickBooks refresh token rejected for subscriber ${subscriberId} ` +
        `(${oauthError}); connection flagged needs-reconnect`,
    );
    this.name = "QboReconnectRequiredError";
    this.oauthError = oauthError;
  }
}

/**
 * A token refresh failed for a reason that is NOT a dead refresh token — a 5xx,
 * a network error, or an unparseable body. The connection is deliberately left
 * untouched (disconnected_at NOT set) so the caller can safely retry later.
 */
export class QboTransientTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QboTransientTokenError";
  }
}

/** The connected_accounts columns the refresh lifecycle reads. */
interface ConnectionRow {
  external_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string | null;
  meta: unknown;
}

/** Exchange an authorization code for the initial token set (used by /callback). */
export function exchangeAuthCode(
  code: string,
  redirectUri: string
): Promise<QboTokenResponse> {
  // redirect_uri must be byte-identical to the one sent on /connect (QBO_REDIRECT_URI).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  return requestQboToken(body);
}

/** Load the single quickbooks connection row for a subscriber, or throw. */
async function loadConnection(
  service: ReturnType<typeof getSupabase>,
  subscriberId: string,
): Promise<ConnectionRow> {
  const { data: row, error } = await service
    .from("connected_accounts")
    .select("external_id, access_token, refresh_token, token_expires_at, meta")
    .eq("subscriber_id", subscriberId)
    .eq("provider", "quickbooks")
    .maybeSingle();

  if (error) {
    throw new Error(`QuickBooks connection lookup failed: ${error.message}`);
  }
  if (!row || !row.external_id || !row.access_token || !row.refresh_token) {
    throw new Error(`No QuickBooks connection found for subscriber ${subscriberId}`);
  }
  return row as ConnectionRow;
}

/**
 * Perform the refresh_token grant, persist the rotated token set, and return the
 * fresh access token. Intuit ROTATES the refresh token on every refresh, so the
 * new refresh_token is captured and re-encrypted.
 *
 * Failure handling (the hardening this module adds):
 *   - `invalid_grant` (dead/expired/revoked refresh token) → flag the connection
 *     needs-reconnect (set disconnected_at), then throw QboReconnectRequiredError.
 *     NOT retryable.
 *   - any other failure (5xx / network / unparseable) → throw
 *     QboTransientTokenError WITHOUT touching connection state, so it stays safe
 *     to retry.
 */
async function refreshAndPersist(
  service: ReturnType<typeof getSupabase>,
  subscriberId: string,
  row: ConnectionRow,
): Promise<{ accessToken: string; realmId: string }> {
  const realmId = row.external_id;
  const refreshToken = decryptSecret(row.refresh_token);

  let refreshed: QboTokenResponse;
  try {
    refreshed = await requestQboToken(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    );
  } catch (err) {
    const oauthError = err instanceof QboTokenError ? err.oauthError : null;

    if (oauthError === "invalid_grant") {
      // Dead refresh token. Flag needs-reconnect (scoped to this subscriber's
      // quickbooks row, mirroring the update path below and in the callback), then
      // surface a typed, non-retryable error.
      const { error: flagError } = await service
        .from("connected_accounts")
        .update({
          disconnected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("subscriber_id", subscriberId)
        .eq("provider", "quickbooks");
      if (flagError) {
        // The grant is still dead (non-retryable), but the flag didn't stick —
        // surface why so ops can see the UI won't prompt reconnect. No tokens here.
        console.error(
          `qbo/tokens: failed to flag needs-reconnect for subscriber ${subscriberId}: ${flagError.message}`,
        );
      }
      throw new QboReconnectRequiredError(subscriberId, "invalid_grant");
    }

    // 5xx / network / unparseable → transient. Leave the connection untouched.
    const message = err instanceof Error ? err.message : String(err);
    throw new QboTransientTokenError(
      `QuickBooks token refresh failed for subscriber ${subscriberId} (transient): ${message}`,
      { cause: err },
    );
  }

  const now = Date.now();
  const newTokenExpiresAt = new Date(now + refreshed.expires_in * 1000).toISOString();
  const newRefreshExpiresAt = new Date(
    now + refreshed.x_refresh_token_expires_in * 1000
  ).toISOString();

  const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<
    string,
    unknown
  >;

  const { error: updateError } = await service
    .from("connected_accounts")
    .update({
      access_token: encryptSecret(refreshed.access_token),
      refresh_token: encryptSecret(refreshed.refresh_token),
      token_expires_at: newTokenExpiresAt,
      meta: { ...meta, refresh_expires_at: newRefreshExpiresAt },
      updated_at: new Date().toISOString(),
    })
    .eq("subscriber_id", subscriberId)
    .eq("provider", "quickbooks");

  if (updateError) {
    throw new Error(`QuickBooks token refresh persist failed: ${updateError.message}`);
  }

  return { accessToken: refreshed.access_token, realmId };
}

/**
 * Return a usable access token for a subscriber, refreshing proactively if the
 * current one is within 5 minutes of expiry.
 *
 * TODO(D2): concurrency. This is naive last-write-wins, which is fine for D1
 * (sandbox, single user). If parallel refreshes can race (multiple workers / a
 * busy production tenant), add a single-flight lock or a DB row lock around the
 * refresh + write-back. Do NOT add locking here yet.
 */
export async function getValidAccessToken(
  subscriberId: string
): Promise<{ accessToken: string; realmId: string }> {
  const service = getSupabase();
  const row = await loadConnection(service, subscriberId);

  const realmId = row.external_id;
  const accessToken = decryptSecret(row.access_token);
  const expiresAtMs = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;

  // Still comfortably valid — return the current token, no network call.
  if (expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
    return { accessToken, realmId };
  }

  // Within the skew window — proactive refresh.
  return refreshAndPersist(service, subscriberId, row);
}

/**
 * Force a token refresh regardless of the proactive clock-skew check, persist the
 * rotated token set, and return the fresh access token. Used by the QBO API
 * clients for reactive 401 recovery: a token the server rejected BEFORE its clock
 * expiry (e.g. server-side revocation) can't be healed by getValidAccessToken
 * (which would see it as still-valid and return it unchanged), so the client
 * force-refreshes once and retries.
 *
 * Same failure contract as the proactive path: QboReconnectRequiredError on a
 * dead refresh token (after flagging needs-reconnect), QboTransientTokenError on
 * a transient failure.
 */
export async function refreshAccessToken(
  subscriberId: string
): Promise<{ accessToken: string; realmId: string }> {
  const service = getSupabase();
  const row = await loadConnection(service, subscriberId);
  return refreshAndPersist(service, subscriberId, row);
}

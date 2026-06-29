import { getSupabase } from "@/lib/supabase";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { requestQboToken, type QboTokenResponse } from "./constants";

// QuickBooks token lifecycle helpers. All persistence goes through encryptSecret;
// all reads through decryptSecret. Never log token values.

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh when within 5 min of expiry

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

/**
 * Return a usable access token for a subscriber, refreshing proactively if the
 * current one is within 5 minutes of expiry. Intuit ROTATES the refresh token on
 * every refresh, so the new refresh_token is captured and re-encrypted.
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

  const realmId = row.external_id;
  const accessToken = decryptSecret(row.access_token);
  const expiresAtMs = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;

  // Still comfortably valid — return the current token, no network call.
  if (expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
    return { accessToken, realmId };
  }

  // Refresh. Capture Intuit's rotated refresh token.
  const refreshToken = decryptSecret(row.refresh_token);
  const refreshed = await requestQboToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  );

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

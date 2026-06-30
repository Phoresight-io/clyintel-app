import { encryptSecret, decryptSecret } from "@/lib/crypto";

// Signed, single-use OAuth state for CSRF protection (RFC 9700). The state value
// is bound to the subscriber and an expiry, then sealed into an HttpOnly cookie
// using the canonical at-rest encryption (encryptSecret). The /callback verifies
// the returned state against the cookie, checks expiry + subscriber, then deletes
// the cookie so it can never be replayed.

export const QBO_STATE_COOKIE = "qbo_oauth_state";
export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const QBO_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 600, // seconds — matches STATE_TTL_MS
};

export interface StatePayload {
  state: string;
  subscriberId: string;
  exp: number; // epoch ms
}

/** Seal the state payload into the encrypted cookie value. */
export function buildStateCookieValue(state: string, subscriberId: string): string {
  const payload: StatePayload = {
    state,
    subscriberId,
    exp: Date.now() + STATE_TTL_MS,
  };
  return encryptSecret(JSON.stringify(payload));
}

/** Decrypt + structurally validate the cookie. Returns null on any failure. */
export function parseStateCookie(value: string | undefined | null): StatePayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decryptSecret(value)) as Partial<StatePayload>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.subscriberId !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    return parsed as StatePayload;
  } catch {
    return null;
  }
}

/**
 * Full verification: cookie decrypts, returned state matches, not expired, and
 * the authenticated user owns it. Any failure → false (caller writes nothing).
 */
export function isStateValid(
  cookieValue: string | undefined | null,
  returnedState: string | null,
  authenticatedSubscriberId: string | null
): boolean {
  const payload = parseStateCookie(cookieValue);
  if (!payload) return false;
  if (!returnedState || payload.state !== returnedState) return false;
  if (payload.exp <= Date.now()) return false;
  if (!authenticatedSubscriberId || payload.subscriberId !== authenticatedSubscriberId) {
    return false;
  }
  return true;
}

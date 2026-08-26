import { encryptSecret, decryptSecret } from "@/lib/crypto";

// Signed, single-use OAuth state for CSRF protection (RFC 9700). The state value
// is bound to the subscriber and an expiry, then sealed into an HttpOnly cookie
// using the canonical at-rest encryption (encryptSecret). The /callback verifies
// the returned state against the cookie, checks expiry + subscriber, then deletes
// the cookie so it can never be replayed.

export const QBO_STATE_COOKIE = "qbo_oauth_state";
export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Where the OAuth callback sends the user after a successful (re)connect, when no
// valid return-to was carried. Reauth from anywhere but Integrations keeps this.
export const DEFAULT_RETURN_TO = "/connections";

// EXACT-match allowlist of in-app return-to paths. An exact set (no prefix/host
// parsing) makes an open-redirect structurally impossible: a value either IS one
// of these strings or it's rejected. Add a new entry here to permit a new origin.
const ALLOWED_RETURN_TO = new Set<string>([
  "/connections",
  "/settings?tab=integrations",
]);

/**
 * Validate an untrusted return-to against the allowlist. Returns the value only
 * if it's an exact allowlisted in-app path; otherwise DEFAULT_RETURN_TO. Applied
 * at BOTH set-time (connect-start) and use-time (callback) so a tampered or stale
 * carrier can never redirect off-allowlist. Never returns an arbitrary URL.
 */
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (typeof value === "string" && ALLOWED_RETURN_TO.has(value)) return value;
  return DEFAULT_RETURN_TO;
}

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
  // Validated in-app return-to path, riding ALONGSIDE the CSRF fields. isStateValid
  // never reads this, so it can't affect the security decision; the callback reads
  // it only after CSRF passes and re-validates it via sanitizeReturnTo.
  returnTo?: string;
}

/** Seal the state payload into the encrypted cookie value. `returnTo`, when given,
 *  is sanitized here (set-time validation) before sealing so only an allowlisted
 *  path is ever stored. */
export function buildStateCookieValue(
  state: string,
  subscriberId: string,
  returnTo?: string,
): string {
  const payload: StatePayload = {
    state,
    subscriberId,
    exp: Date.now() + STATE_TTL_MS,
  };
  if (returnTo) {
    const safe = sanitizeReturnTo(returnTo);
    // Only store a non-default return-to; the callback defaults on absence anyway.
    if (safe !== DEFAULT_RETURN_TO) payload.returnTo = safe;
  }
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
    const payload: StatePayload = {
      state: parsed.state,
      subscriberId: parsed.subscriberId,
      exp: parsed.exp,
    };
    // returnTo is optional and non-security-critical; carry it only if it's a
    // string, and re-validate at use-time (never trust the carrier blindly).
    if (typeof parsed.returnTo === "string") payload.returnTo = parsed.returnTo;
    return payload;
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

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createSupabaseServer } from "@/lib/supabase-server";
import { INTUIT_AUTHORIZE_URL, QBO_SCOPE } from "@/lib/qbo/constants";
import {
  QBO_STATE_COOKIE,
  QBO_STATE_COOKIE_OPTIONS,
  buildStateCookieValue,
  sanitizeReturnTo,
} from "@/lib/qbo/oauthState";

// Native QuickBooks OAuth entry point (replaces the retired Make scenario). Used
// for both first connect and reconnect — both mint a fresh signed state cookie and
// 302 to Intuit's consent screen. user.id IS the subscriber id.
//
// Optional ?returnTo=<in-app path> lets the caller (e.g. the Integrations
// ReAuthorize button) ask the callback to land the user back where they started.
// It's validated against an allowlist HERE (set-time) and again in the callback
// (use-time), and rides inside the sealed state cookie — never in the CSRF state
// nonce — so it can't weaken the CSRF binding or open a redirect.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const clientId = process.env.QBO_CLIENT_ID;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    console.error("qbo/connect: QBO_CLIENT_ID or QBO_REDIRECT_URI not configured");
    return NextResponse.json({ error: "QuickBooks is not configured" }, { status: 500 });
  }

  // CSRF state: 32 random bytes, base64url. Bound to the subscriber in a signed,
  // HttpOnly cookie verified on the callback.
  const state = randomBytes(32).toString("base64url");

  // Validated at set-time; anything not on the allowlist collapses to the default
  // so a bad ?returnTo can never be sealed into the cookie.
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("returnTo"));

  const authorizeUrl = new URL(INTUIT_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", QBO_SCOPE);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authorizeUrl.toString(), { status: 302 });
  res.cookies.set(
    QBO_STATE_COOKIE,
    buildStateCookieValue(state, user.id, returnTo),
    QBO_STATE_COOKIE_OPTIONS
  );
  return res;
}

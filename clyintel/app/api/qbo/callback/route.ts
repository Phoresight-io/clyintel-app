import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { encryptSecret } from "@/lib/crypto";
import { QBO_SCOPE } from "@/lib/qbo/constants";
import { exchangeAuthCode } from "@/lib/qbo/tokens";
import { QBO_STATE_COOKIE, isStateValid } from "@/lib/qbo/oauthState";

// QuickBooks OAuth callback. Validates the signed state cookie, exchanges the
// code for tokens, and upserts the encrypted token set into connected_accounts
// (provider='quickbooks'). Never writes subscribers.qbo_* and never logs tokens.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const params = url.searchParams;
  const code = params.get("code");
  const realmId = params.get("realmId");
  const returnedState = params.get("state");
  const errorParam = params.get("error");

  const redirectTo = (qbo: string) =>
    NextResponse.redirect(`${url.origin}/connections?qbo=${qbo}`, { status: 303 });

  // Single-use cookie: always clear it once we've reached the callback.
  const finish = (qbo: string) => {
    const res = redirectTo(qbo);
    res.cookies.delete(QBO_STATE_COOKIE);
    return res;
  };

  // User denied consent on Intuit — no write.
  if (errorParam) {
    return finish("denied");
  }

  // Re-establish the authenticated user (user.id IS the subscriber id).
  const authClient = await createSupabaseServer();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  // CSRF: cookie must decrypt, state must match, not expired, and bound to this user.
  const cookieValue = req.cookies.get(QBO_STATE_COOKIE)?.value;
  if (!isStateValid(cookieValue, returnedState, user?.id ?? null)) {
    return finish("state_invalid");
  }
  if (!code || !realmId) {
    return finish("state_invalid");
  }

  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!redirectUri) {
    console.error("qbo/callback: QBO_REDIRECT_URI not configured");
    return finish("error");
  }

  // Exchange the code (redirect_uri byte-identical to /connect).
  let tokens;
  try {
    tokens = await exchangeAuthCode(code, redirectUri);
  } catch (err) {
    console.error("qbo/callback: token exchange failed", err);
    return finish("error");
  }

  const now = Date.now();
  const tokenExpiresAt = new Date(now + tokens.expires_in * 1000).toISOString();
  const refreshExpiresAt = new Date(
    now + tokens.x_refresh_token_expires_in * 1000
  ).toISOString();

  // user is guaranteed non-null here (isStateValid required user?.id to match).
  const subscriberId = user!.id;
  const service = getSupabase();

  const { error: upsertError } = await service.from("connected_accounts").upsert(
    {
      subscriber_id: subscriberId,
      provider: "quickbooks",
      external_id: realmId,
      access_token: encryptSecret(tokens.access_token),
      refresh_token: encryptSecret(tokens.refresh_token),
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
      meta: {
        token_type: "bearer",
        scope: QBO_SCOPE,
        refresh_expires_at: refreshExpiresAt,
        environment: process.env.QBO_ENVIRONMENT ?? null,
      },
    },
    { onConflict: "subscriber_id,provider" }
  );

  if (upsertError) {
    console.error("qbo/callback: failed to persist connected account", upsertError);
    return finish("error");
  }

  // Audit — minimal, non-secret. NEVER log token values.
  await service.from("audit_log").insert({
    subscriber_id: subscriberId,
    actor: "system",
    actor_detail: "qbo-oauth-callback",
    action: "connect_quickbooks",
    entity_type: "connected_account",
    entity_id: realmId,
    payload: {
      provider: "quickbooks",
      realm_id: realmId,
      scope: QBO_SCOPE,
      environment: process.env.QBO_ENVIRONMENT ?? null,
    } as never,
  });

  return finish("connected");
}

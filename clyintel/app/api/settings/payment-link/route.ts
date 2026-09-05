import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { validatePaymentLink } from "@/lib/validatePaymentLink";

// Set/update the authenticated subscriber's account-level default payment link
// (Brick A′-1). Auth + write conventions mirror the other settings mutations
// (see app/api/connect/disconnect/route.ts): identify the subscriber from the
// authed server client, then write with the service-role client scoped to that
// subscriber's own row.
//
// This route intentionally has NO clear path: an empty or otherwise invalid
// value is rejected at validation and never written, so null/empty can't be
// persisted here. The guarded clear/remove path ships separately in A′-2.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PaymentLinkBody {
  payment_link_url: string;
}

export async function POST(req: NextRequest) {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: PaymentLinkBody;
  try {
    body = (await req.json()) as PaymentLinkBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = validatePaymentLink(body?.payment_link_url ?? "");
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  const service = getSupabase();
  const { error: updateError } = await service
    .from("subscribers")
    .update({ payment_link_url: result.url })
    .eq("id", user.id);

  if (updateError) {
    console.error("settings/payment-link: failed to update", updateError);
    return NextResponse.json({ error: "Could not save payment link" }, { status: 500 });
  }

  return NextResponse.json({ payment_link_url: result.url });
}

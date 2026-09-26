import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { validateBusinessName } from "@/lib/subscriber/businessName";

// Set/update the authenticated subscriber's customer-facing business name
// (subscribers.business_name): what the Recovery Agent says on calls and what
// signs payment/cadence emails. Auth + write conventions mirror
// app/api/settings/payment-link: identify the subscriber from the authed server
// client, then write with the service-role client scoped to that subscriber's
// own row. Trimmed; empty rejected; max 120 characters.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { business_name?: unknown };
  try {
    body = (await req.json()) as { business_name?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = validateBusinessName(body?.business_name);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  const service = getSupabase();
  const { error: updateError } = await service
    .from("subscribers")
    .update({ business_name: result.name })
    .eq("id", user.id);

  if (updateError) {
    console.error("settings/business-name: failed to update", updateError);
    return NextResponse.json({ error: "Could not save business name" }, { status: 500 });
  }

  return NextResponse.json({ business_name: result.name });
}

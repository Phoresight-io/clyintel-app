import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import {
  createContact,
  updateContact,
  deleteContact,
  type ContactMutationPort,
  type ContactRow,
  type MutationResult,
} from "@/lib/contacts/mutateContact";

// Client-contact mutation route (Contacts Brick 4a) — the app's first client-write
// surface. Manages DUNNING contacts only: create (POST), update (PATCH), delete
// (DELETE). Point-of-contact rows are QBO-owned and rejected by the pure core.
//
// Auth + write conventions mirror app/api/settings/payment-link/route.ts and the
// subscriber-scoped-SELECT-then-service-write ownership pattern of
// app/api/invoices/create/route.ts. All business logic (ownership gate, PoC guard,
// email validation, 23505 → 409) lives in the pure, unit-tested core
// lib/contacts/mutateContact.ts; this file only authenticates, parses, wires the
// service-role port, and maps the result onto a response.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTACT_COLUMNS =
  "id, client_id, contact_type, email, phone, email_rank, sms_rank, voice_rank, opt_out_email, opt_out_sms, opt_out_voice";

// Build the mutation port from the service-role client. Ownership is enforced by
// the subscriber-scoped SELECT here (the service client bypasses RLS), and the
// 23505 unique-violation is translated to { conflict: true } for the core — the
// same distinct-catch discipline as app/api/outreach/run/route.ts's claimStep.
function makePort(
  service: ReturnType<typeof getSupabase>,
  userId: string,
): ContactMutationPort {
  return {
    async isClientOwned(clientId) {
      const { data, error } = await service
        .from("clients")
        .select("id")
        .eq("id", clientId)
        .eq("subscriber_id", userId)
        .maybeSingle();
      if (error) throw new Error(`clients/contacts: ownership check failed: ${error.message}`);
      return !!data;
    },
    async loadContactMeta(id) {
      const { data, error } = await service
        .from("client_contacts")
        .select("id, client_id, contact_type")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`clients/contacts: contact load failed: ${error.message}`);
      return data ?? null;
    },
    async insertContact(row) {
      const { data, error } = await service
        .from("client_contacts")
        .insert(row)
        .select(CONTACT_COLUMNS)
        .single();
      if (error) {
        if (error.code === "23505") return { ok: false, conflict: true };
        throw new Error(`clients/contacts: insert failed: ${error.message}`);
      }
      return { ok: true, row: data as unknown as ContactRow };
    },
    async updateContact(id, patch) {
      const { data, error } = await service
        .from("client_contacts")
        .update(patch)
        .eq("id", id)
        .select(CONTACT_COLUMNS)
        .single();
      if (error) {
        if (error.code === "23505") return { ok: false, conflict: true };
        throw new Error(`clients/contacts: update failed: ${error.message}`);
      }
      return { ok: true, row: data as unknown as ContactRow };
    },
    async deleteContact(id) {
      const { error } = await service.from("client_contacts").delete().eq("id", id);
      if (error) throw new Error(`clients/contacts: delete failed: ${error.message}`);
    },
  };
}

// Shared auth gate — identical 401 shape to the other settings mutations.
async function authenticate(): Promise<
  { userId: string } | { response: NextResponse }
> {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();
  if (error || !user) {
    return { response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  return { userId: user.id };
}

function respond(result: MutationResult): NextResponse {
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(req: NextRequest) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const port = makePort(getSupabase(), auth.userId);
  return respond(await createContact(body, port));
}

export async function PATCH(req: NextRequest) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const port = makePort(getSupabase(), auth.userId);
  return respond(await updateContact(body, port));
}

export async function DELETE(req: NextRequest) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;

  // DELETE carries no reliable body across all clients — take the id from the
  // query string (?id=<uuid>) and hand the core the same { id } shape.
  const id = new URL(req.url).searchParams.get("id");
  const port = makePort(getSupabase(), auth.userId);
  return respond(await deleteContact({ id }, port));
}

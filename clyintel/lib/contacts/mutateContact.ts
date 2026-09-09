// Pure decision core for the client-contact mutation route (Contacts Brick 4a).
//
// This is the FIRST client-write surface in the app. All security-critical rules
// live here as pure functions over an injected ContactMutationPort, so every
// branch (ownership gate, PoC read-only guard, email validation, per-channel-rank
// 23505 → 409) is deterministically unit-testable without a database. The route
// (app/api/clients/contacts/route.ts) is a thin shell: authenticate, parse the
// body, build the real port from the service-role client, map the result to a
// NextResponse. Mirrors the port pattern used by mailersend/route.ts.
//
// LOCKED RULES (Brick 4a):
//   - Ownership: every op first proves the target client belongs to the caller
//     (port.isClientOwned). The service client bypasses RLS, so THIS check — not
//     RLS — is the enforcement. No ownership → 403, no write.
//   - PoC read-only: create always forces contact_type = "dunning" (never accepts
//     it from the body); update/delete refuse a contact_type = "poc" row → 403.
//     PoC contacts are QBO-owned (see planPocReconcile.ts).
//   - Rank uniqueness: a per-channel-rank collision surfaces from the port as
//     { conflict: true } (a 23505 unique violation) → 409, never swallowed.
//
// No `@/` imports (validateEmail is reached relatively) so this stays a leaf pure
// module, same convention as contactDisplay / planPocReconcile.

import { validateEmail } from "../validateEmail";

// The contact columns this route may write. contact_type is intentionally ABSENT:
// create forces "dunning", update never changes it. is_primary is absent too — it
// stays the DB default (false); this route never touches the retiring primary flag.
export interface ContactWriteFields {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  email_rank?: number | null;
  sms_rank?: number | null;
  voice_rank?: number | null;
  opt_out_email?: boolean;
  opt_out_sms?: boolean;
  opt_out_voice?: boolean;
}

// What the port inserts: a dunning contact for a client. contact_type is forced
// by the core, never taken from the request.
export interface DunningInsert extends ContactWriteFields {
  client_id: string;
  contact_type: "dunning";
}

// The row shape returned to the caller after a create/update.
export interface ContactRow extends ContactWriteFields {
  id: string;
  client_id: string;
  contact_type: string | null;
}

// Minimal metadata needed to gate an update/delete.
export interface ContactMeta {
  id: string;
  client_id: string;
  contact_type: string | null;
}

export type WriteOutcome =
  | { ok: true; row: ContactRow }
  | { ok: false; conflict: true }; // per-channel-rank unique violation (23505)

export interface ContactMutationPort {
  // Subscriber-scoped ownership check on the parent client (the security gate).
  isClientOwned(clientId: string): Promise<boolean>;
  // null when the id does not exist.
  loadContactMeta(id: string): Promise<ContactMeta | null>;
  insertContact(row: DunningInsert): Promise<WriteOutcome>;
  updateContact(id: string, patch: ContactWriteFields): Promise<WriteOutcome>;
  deleteContact(id: string): Promise<void>;
}

// The route maps { status, body } straight onto NextResponse.json(body, { status }).
export interface MutationResult {
  status: number;
  body: Record<string, unknown> | ContactRow;
}

const RANK_CONFLICT = "That rank is already in use for this channel.";
const POC_READONLY =
  "Point-of-contact contacts are read-only (managed by QuickBooks).";
const NOT_OWNED = "Client not found or not owned.";

function err(status: number, message: string): MutationResult {
  return { status, body: { error: message } };
}

function asObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// Whitelist the writable fields off an untrusted body. Only sets a key when the
// value carries a valid type, so a bad type is ignored rather than written.
// Never surfaces contact_type, is_primary, id, or client_id — those are handled
// (or forbidden) by the callers explicitly.
function pickWriteFields(obj: Record<string, unknown>): ContactWriteFields {
  const out: ContactWriteFields = {};
  if ("name" in obj && (typeof obj.name === "string" || obj.name === null)) {
    out.name = obj.name;
  }
  if ("email" in obj && (typeof obj.email === "string" || obj.email === null)) {
    out.email = obj.email;
  }
  if ("phone" in obj && (typeof obj.phone === "string" || obj.phone === null)) {
    out.phone = obj.phone;
  }
  for (const k of ["email_rank", "sms_rank", "voice_rank"] as const) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v === "number" || v === null) out[k] = v;
    }
  }
  for (const k of ["opt_out_email", "opt_out_sms", "opt_out_voice"] as const) {
    if (k in obj && typeof obj[k] === "boolean") out[k] = obj[k] as boolean;
  }
  return out;
}

// CREATE — always a dunning contact. Order: ownership → email → insert.
export async function createContact(
  body: unknown,
  port: ContactMutationPort,
): Promise<MutationResult> {
  const obj = asObject(body);
  if (!obj) return err(400, "Invalid request body.");

  const clientId = asString(obj.client_id);
  if (!clientId) return err(400, "client_id is required.");

  if (!(await port.isClientOwned(clientId))) return err(403, NOT_OWNED);

  const emailCheck = validateEmail(asString(obj.email) ?? "");
  if (!emailCheck.ok) {
    return err(400, emailCheck.reason === "empty" ? "Email is required." : emailCheck.reason);
  }

  const fields = pickWriteFields(obj);
  // Validated email wins over the raw picked value; contact_type is forced.
  const insert: DunningInsert = {
    ...fields,
    client_id: clientId,
    contact_type: "dunning",
    email: emailCheck.email,
  };

  const res = await port.insertContact(insert);
  if (!res.ok) return err(409, RANK_CONFLICT);
  return { status: 201, body: res.row };
}

// UPDATE — dunning only. Order: load → 404 → ownership → PoC guard → email → update.
export async function updateContact(
  body: unknown,
  port: ContactMutationPort,
): Promise<MutationResult> {
  const obj = asObject(body);
  if (!obj) return err(400, "Invalid request body.");

  const id = asString(obj.id);
  if (!id) return err(400, "id is required.");

  const meta = await port.loadContactMeta(id);
  if (!meta) return err(404, "Contact not found.");

  if (!(await port.isClientOwned(meta.client_id))) return err(403, NOT_OWNED);
  if (meta.contact_type === "poc") return err(403, POC_READONLY);

  const fields = pickWriteFields(obj);
  // Email is optional on update, but if the key is present it must be valid.
  if ("email" in obj) {
    const emailCheck = validateEmail(asString(obj.email) ?? "");
    if (!emailCheck.ok) {
      return err(400, emailCheck.reason === "empty" ? "Email cannot be empty." : emailCheck.reason);
    }
    fields.email = emailCheck.email;
  }

  const res = await port.updateContact(id, fields);
  if (!res.ok) return err(409, RANK_CONFLICT);
  return { status: 200, body: res.row };
}

// DELETE — dunning only. Order: load → 404 → ownership → PoC guard → delete.
export async function deleteContact(
  body: unknown,
  port: ContactMutationPort,
): Promise<MutationResult> {
  const obj = asObject(body);
  if (!obj) return err(400, "Invalid request body.");

  const id = asString(obj.id);
  if (!id) return err(400, "id is required.");

  const meta = await port.loadContactMeta(id);
  if (!meta) return err(404, "Contact not found.");

  if (!(await port.isClientOwned(meta.client_id))) return err(403, NOT_OWNED);
  if (meta.contact_type === "poc") return err(403, POC_READONLY);

  await port.deleteContact(id);
  return { status: 200, body: { deleted: true } };
}

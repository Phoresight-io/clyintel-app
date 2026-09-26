// get_account (in-call agent tool, app/api/voice/tools): what the agent may see
// about the account on THIS call, so it can decide whether and whom to email.
// Read-only. NEVER includes the payment link (that stays DB-resolved inside the
// send and is never spoken).
//
// Emails are returned in FULL: the agent reads the on-file address back to the
// caller to confirm before sending. `emailable` = has an email, the contact is
// not opted out of email, and the client is not opted out of email. Voice opt-out
// is not consulted: this is the email channel.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import { EMAIL_CHANNEL, selectForChannel, type ContactRow } from "../outreach/selectRecipients";
import { formatAmountDue, formatHumanDate } from "./buildCallVariables";

export interface AccountView {
  client_name: string;
  invoice: { number: string; amount_due: string; due_date: string } | null;
  contacts: {
    contact_id: string;
    name: string | null;
    role: string | null;
    contact_type: string | null;
    email: string | null;
    emailable: boolean;
  }[];
  default_contact_id: string | null;
  // voice_calls.handoff_email_status: null = nothing sent yet on this call.
  payment_email_status: string | null;
}

export interface AccountSources {
  client: { name: string | null; opt_out_email: boolean | null } | null;
  invoice: { invoice_number: string | null; amount_outstanding_cents: number | null; due_date: string | null } | null;
  contacts: ContactRow[];
  paymentEmailStatus: string | null;
}

export function isEmailable(c: ContactRow, clientOptOutEmail: boolean | null | undefined): boolean {
  return (
    typeof c.email === "string" && c.email.trim() !== "" && c.opt_out_email === false && clientOptOutEmail === false
  );
}

// Pure: assemble the view from already-loaded rows.
export function buildAccountView(src: AccountSources): AccountView {
  const clientOptOut = src.client?.opt_out_email;
  const fallback = clientOptOut === false ? selectForChannel(src.contacts, EMAIL_CHANNEL) : null;
  return {
    client_name: src.client?.name?.trim() ?? "",
    invoice: src.invoice
      ? {
          number: src.invoice.invoice_number ?? "",
          amount_due: formatAmountDue(src.invoice.amount_outstanding_cents),
          due_date: formatHumanDate(src.invoice.due_date),
        }
      : null,
    contacts: src.contacts.map((c) => ({
      contact_id: c.id,
      name: c.name,
      role: c.role,
      contact_type: c.contact_type,
      email: c.email,
      emailable: isEmailable(c, clientOptOut),
    })),
    default_contact_id: fallback?.id ?? null,
    payment_email_status: src.paymentEmailStatus,
  };
}

// Load by voice call id. The call row supplies subscriber/client/invoice; the
// service-role client bypasses RLS, so client and invoice reads are scoped to the
// call's subscriber (and client) explicitly. null = no such call.
export async function loadAccountForCall(
  service: SupabaseClient<Database>,
  voiceCallId: string,
): Promise<AccountView | null> {
  const { data: call, error } = await service
    .from("voice_calls")
    .select("subscriber_id, client_id, invoice_id, handoff_email_status")
    .eq("id", voiceCallId)
    .maybeSingle();
  if (error) throw new Error(`voice/accountView: voice_calls read failed: ${error.message}`);
  if (!call) return null;

  const [clientRes, invRes, contactsRes] = await Promise.all([
    service
      .from("clients")
      .select("name, opt_out_email")
      .eq("id", call.client_id)
      .eq("subscriber_id", call.subscriber_id)
      .maybeSingle(),
    call.invoice_id
      ? service
          .from("invoices")
          .select("invoice_number, amount_outstanding_cents, due_date")
          .eq("id", call.invoice_id)
          .eq("subscriber_id", call.subscriber_id)
          .eq("client_id", call.client_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    service.from("client_contacts").select("*").eq("client_id", call.client_id),
  ]);
  if (clientRes.error) throw new Error(`voice/accountView: client read failed: ${clientRes.error.message}`);
  if (invRes.error) throw new Error(`voice/accountView: invoice read failed: ${invRes.error.message}`);
  if (contactsRes.error) throw new Error(`voice/accountView: contacts read failed: ${contactsRes.error.message}`);

  return buildAccountView({
    client: clientRes.data,
    invoice: invRes.data,
    // Contacts only for a client that belongs to the call's subscriber.
    contacts: clientRes.data ? (contactsRes.data ?? []) : [],
    paymentEmailStatus: call.handoff_email_status,
  });
}

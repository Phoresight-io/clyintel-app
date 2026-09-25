// Server-side Vapi variableValues for an outbound call (app/api/voice/call).
//
// Why: callers rarely send `variables`, so the assistant's {{tokens}} rendered
// empty and the agent improvised (spoke token names aloud, invented details). The
// route now builds the variables from the DB by id, so a caller that passes only
// ids still gets a fully grounded agent. Values in body.variables are merged OVER
// these (explicit caller override wins).
//
// The assistant's {{token}} names MUST match these keys exactly; a mismatched
// token renders empty. Default key set (extra keys are ignored by Vapi):
//   contact_name, client_name, invoice_number, amount_due, due_date,
//   days_past_due, subscriber_name, payment_channel
//
// Reads use the same columns sendEmailStep renders from. The service-role client
// bypasses RLS, so invoice/client/subscriber reads are filtered by subscriber_id
// explicitly; contacts are read only for a client that belongs to the subscriber.
// NEVER throws on missing data: a missing invoice/contact leaves those keys ""
// (a partially grounded agent beats no call). Read errors are logged and treated
// as missing.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import {
  EMAIL_CHANNEL,
  selectForChannel,
  type ChannelDescriptor,
  type ContactRow,
} from "../outreach/selectRecipients";
import { daysBetweenUtcDates } from "../score/dates";

// Voice channel for selectForChannel: dunning voice_rank → poc, phone present,
// not opted out of voice.
export const VOICE_CHANNEL: ChannelDescriptor = {
  channel: "voice",
  rankColumn: "voice_rank",
  optOutField: "opt_out_voice",
  addressField: "phone",
};

export const CALL_VARIABLE_KEYS = [
  "contact_name",
  "client_name",
  "invoice_number",
  "amount_due",
  "due_date",
  "days_past_due",
  "subscriber_name",
  "payment_channel",
] as const;

export type CallVariables = Record<(typeof CALL_VARIABLE_KEYS)[number], string>;

export interface CallVariableSources {
  invoice: { invoice_number: string | null; amount_outstanding_cents: number | null; due_date: string | null } | null;
  client: { name: string | null } | null;
  subscriber: { business_name: string | null; contact_name: string | null } | null;
  contacts: ContactRow[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2026-06-28" → "June 28, 2026". Parsed from the YMD digits, so there is no
// locale or timezone drift. Unparseable → "".
export function formatHumanDate(ymd: string | null): string {
  if (!ymd) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return "";
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

// 27000 → "$270.00". null → "".
export function formatAmountDue(cents: number | null | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "";
}

// Whole UTC calendar days past due (never negative); "" without a due date.
export function daysPastDue(dueYmd: string | null, now: Date): string {
  if (!dueYmd) return "";
  const days = daysBetweenUtcDates(dueYmd, now);
  return days === null ? "" : String(Math.max(0, days));
}

// Pure: assemble the variable set from already-loaded rows.
export function callVariablesFrom(src: CallVariableSources, now: Date): CallVariables {
  // Voice contact first; if none resolves, fall back to the email contact so
  // contact_name is still populated when only an emailable contact exists.
  const contact = selectForChannel(src.contacts, VOICE_CHANNEL) ?? selectForChannel(src.contacts, EMAIL_CHANNEL);
  const clientName = src.client?.name?.trim() || "";
  const inv = src.invoice;
  return {
    contact_name: contact?.name?.trim() || clientName || "there",
    client_name: clientName,
    invoice_number: inv?.invoice_number ?? "",
    amount_due: inv ? formatAmountDue(inv.amount_outstanding_cents) : "",
    due_date: inv ? formatHumanDate(inv.due_date) : "",
    days_past_due: inv ? daysPastDue(inv.due_date, now) : "",
    subscriber_name: src.subscriber?.business_name || src.subscriber?.contact_name || "our team",
    payment_channel: "email",
  };
}

export async function buildCallVariables(
  service: SupabaseClient<Database>,
  ids: { subscriberId: string; clientId: string; invoiceId: string | null },
  now: Date = new Date(),
): Promise<CallVariables> {
  const [invRes, clientRes, subRes] = await Promise.all([
    ids.invoiceId
      ? service
          .from("invoices")
          .select("invoice_number, amount_outstanding_cents, due_date")
          .eq("id", ids.invoiceId)
          .eq("subscriber_id", ids.subscriberId)
          .eq("client_id", ids.clientId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    service
      .from("clients")
      .select("name")
      .eq("id", ids.clientId)
      .eq("subscriber_id", ids.subscriberId)
      .maybeSingle(),
    service
      .from("subscribers")
      .select("business_name, contact_name")
      .eq("id", ids.subscriberId)
      .maybeSingle(),
  ]);
  if (invRes.error) console.error("voice/buildCallVariables: invoice read failed", invRes.error);
  if (clientRes.error) console.error("voice/buildCallVariables: client read failed", clientRes.error);
  if (subRes.error) console.error("voice/buildCallVariables: subscriber read failed", subRes.error);

  let contacts: ContactRow[] = [];
  if (clientRes.data) {
    const { data, error } = await service.from("client_contacts").select("*").eq("client_id", ids.clientId);
    if (error) console.error("voice/buildCallVariables: client_contacts read failed", error);
    contacts = data ?? [];
  }

  return callVariablesFrom(
    {
      invoice: invRes.data ?? null,
      client: clientRes.data ?? null,
      subscriber: subRes.data ?? null,
      contacts,
    },
    now,
  );
}

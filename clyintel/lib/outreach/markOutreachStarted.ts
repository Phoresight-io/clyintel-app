import type { SupabaseClient } from "@supabase/supabase-js";

// The ONE shared "outreach started" stamp (schema/add_invoices_outreach_started_at.sql).
//
// LOCKED RULE: if outreach on ANY channel started on the invoice before the
// payment, the payment is billable; otherwise it is not. invoices.outreach_started_at
// is the single marker every billing gate reads, and this is its only writer.
//
// Called at the first REAL contact on each channel:
//   email — sendEmailStep, live "sent" branch only (MailerSend accepted the send);
//   voice — app/api/voice/call, Vapi-200 branch (vapi_call_id + started_at written);
//   sms   — no real send path exists yet. When one is built, call this at the point
//           the provider (Twilio) accepts the message — never on a dry run.
// Never call it for a dry run, a simulation, or a send the provider rejected.
//
// WRITE-ONCE + RACE-SAFE: the conditional UPDATE (… AND outreach_started_at IS NULL)
// means the first stamp wins and a later or concurrent call is a no-op, so the
// marker only ever records the EARLIEST contact.
//
// NEVER THROWS: the send has already happened by the time this runs, so a stamp
// failure must not fail or roll back the send. It is logged loudly instead (the
// invoice will under-bill until it is stamped — the migration's backfill query
// can re-derive it from communications / voice_calls).

export type OutreachChannel = "email" | "voice" | "sms";

export type MarkOutreachResult = "stamped" | "already_stamped" | "error";

export async function markOutreachStarted(
  service: Pick<SupabaseClient, "from">,
  invoiceId: string,
  startedAt: string,
  channel: OutreachChannel,
): Promise<MarkOutreachResult> {
  try {
    const { data, error } = await service
      .from("invoices")
      .update({ outreach_started_at: startedAt })
      .eq("id", invoiceId)
      .is("outreach_started_at", null)
      .select("id");
    if (error) {
      console.error(
        `markOutreachStarted: FAILED to stamp invoice ${invoiceId} (channel=${channel}, at=${startedAt}) — ` +
          `fee eligibility will under-report until stamped: ${error.message}`,
      );
      return "error";
    }
    return data && data.length > 0 ? "stamped" : "already_stamped";
  } catch (err) {
    console.error(
      `markOutreachStarted: FAILED to stamp invoice ${invoiceId} (channel=${channel}, at=${startedAt}) — ` +
        `fee eligibility will under-report until stamped`,
      err,
    );
    return "error";
  }
}

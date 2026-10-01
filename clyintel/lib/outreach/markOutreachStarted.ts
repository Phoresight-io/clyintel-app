import type { SupabaseClient } from "@supabase/supabase-js";

// Write-once outreach marker: invoices.outreach_started_at. The fee gate
// (lib/capture/outreachBeforePayment) bills only when this marker predates the
// payment, so it must record the FIRST real outreach and never move later.
//
// Race-safe by construction: the update only matches while the column is still
// null, so concurrent or later outreach (a second email, a call after an email)
// can never overwrite an earlier stamp.
//
// Callers (locked rules, 2026-09-30):
//   - sendEmailStep, live send succeeded with a MailerSend message id;
//   - app/api/voice/call, Vapi returned 200 with a call id.
//
// NEVER throws: the outreach already happened, so a marker failure must not
// fail the send/call. It is logged loudly; re-running the idempotent backfill
// (schema/2026-10-01_invoices_outreach_started_at.sql) fills any gap from
// communications + voice_calls.

export async function markOutreachStarted(
  service: SupabaseClient,
  args: { subscriberId: string; invoiceId: string; startedAt: string },
): Promise<void> {
  try {
    const { error } = await service
      .from("invoices")
      .update({ outreach_started_at: args.startedAt })
      .eq("id", args.invoiceId)
      .eq("subscriber_id", args.subscriberId)
      .is("outreach_started_at", null);
    if (error) {
      console.error(
        `markOutreachStarted: FAILED to stamp invoices.outreach_started_at ` +
          `(invoice=${args.invoiceId} subscriber=${args.subscriberId} at=${args.startedAt}): ${error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `markOutreachStarted: FAILED to stamp invoices.outreach_started_at ` +
        `(invoice=${args.invoiceId} subscriber=${args.subscriberId} at=${args.startedAt})`,
      err,
    );
  }
}

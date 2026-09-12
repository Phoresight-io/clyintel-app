import { createSupabaseServer } from "@/lib/supabase-server";

// Voice-call history reads. Unlike the service-role queries in lib/data.ts, these
// go through the cookie-bound SSR client (`createSupabaseServer()`), so RLS does
// the subscriber scoping: voice_calls has the `subscriber_isolation` policy
// (subscriber_id = auth.uid()), meaning no manual subscriber filter is needed —
// or allowed to be relied on — here. Fail closed → [].

// Display shape the call-history UI consumes: the voice columns plus the
// invoice_number joined from invoices, so a call can be matched to its UI invoice
// id (invoice_number || invoices.id, per toUIInvoice).
export interface VoiceCallDisplay {
  id: string;
  invoice_id: string | null;
  status: string;
  outcome: string | null;
  ended_reason: string | null;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  duration_seconds: number | null;
  cost_usd: number | null;
  payment_committed: boolean;
  committed_amount: number | null;
  committed_date: string | null;
  created_at: string;
  ended_at: string | null;
  invoice_number: string | null;
}

const VOICE_CALL_SELECT =
  "id, invoice_id, status, outcome, ended_reason, transcript, summary, recording_url, duration_seconds, cost_usd, payment_committed, committed_amount, committed_date, created_at, ended_at, invoice:invoices(invoice_number)";

// Voice calls for an invoice and/or a client, newest first. Both filters are
// optional; pass whichever is relevant. RLS restricts rows to the caller.
export async function getVoiceCalls(
  opts: { invoiceId?: string; clientId?: string } = {},
): Promise<VoiceCallDisplay[]> {
  const supabase = await createSupabaseServer();
  // Apply .eq() filters BEFORE .order() so the builder stays a filter builder.
  let query = supabase.from("voice_calls").select(VOICE_CALL_SELECT);
  if (opts.invoiceId) query = query.eq("invoice_id", opts.invoiceId);
  if (opts.clientId) query = query.eq("client_id", opts.clientId);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    console.error("getVoiceCalls error", error);
    return []; // fail closed → no calls shown
  }

  return (data ?? []).map((row) => {
    const invoice = Array.isArray(row.invoice) ? row.invoice[0] : row.invoice;
    return {
      id: row.id,
      invoice_id: row.invoice_id,
      status: row.status,
      outcome: row.outcome,
      ended_reason: row.ended_reason,
      transcript: row.transcript,
      summary: row.summary,
      recording_url: row.recording_url,
      duration_seconds: row.duration_seconds,
      cost_usd: row.cost_usd,
      payment_committed: row.payment_committed,
      committed_amount: row.committed_amount,
      committed_date: row.committed_date,
      created_at: row.created_at,
      ended_at: row.ended_at,
      invoice_number: invoice?.invoice_number ?? null,
    };
  });
}

// UI match key for a call: the invoice_number when present, else the raw
// invoice_id — mirrors toUIInvoice's `invoice_number || invoices.id` so a call
// lines up with the invoice id the detail screen selects on.
export function voiceCallInvoiceKey(call: VoiceCallDisplay): string | null {
  return call.invoice_number ?? call.invoice_id;
}

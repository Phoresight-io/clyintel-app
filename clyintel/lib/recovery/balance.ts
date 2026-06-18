import { getSupabase } from "@/lib/supabase";

// Canonical remaining balance for an invoice, computed from the payments ledger.
//
// This is the SEAM: today it reads Supabase (invoices.amount_cents minus the sum
// of invoice_payments rows). When a QBO/FreshBooks sync supplies a fresher figure
// in a later prompt, swap out this implementation without touching any caller.
//
// Always returns a non-negative integer (cents). Server-only: uses service-role.
export async function getRemainingBalance(invoiceId: string): Promise<number> {
  const service = getSupabase();

  const { data: invoice, error: invErr } = await service
    .from("invoices")
    .select("amount_cents")
    .eq("id", invoiceId)
    .single();

  if (invErr || !invoice) {
    throw new Error(`getRemainingBalance: invoice not found — ${invoiceId}`);
  }

  const { data: allocated, error: payErr } = await service
    .from("invoice_payments")
    .select("amount_cents")
    .eq("invoice_id", invoiceId);

  if (payErr) {
    throw new Error(`getRemainingBalance: could not fetch payments — ${payErr.message}`);
  }

  const paid = (allocated ?? []).reduce((sum, row) => sum + row.amount_cents, 0);
  return Math.max(0, invoice.amount_cents - paid);
}

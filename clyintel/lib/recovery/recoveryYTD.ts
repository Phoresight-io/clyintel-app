// Recovery YTD: money recovered from debtors this calendar year (UTC), read from
// rev_share_ledger — one row per credited recovery, across every source (qbo,
// stripe_recovery, ...). Not payments / recovery_attempts: those double-count
// Stripe or miss QBO. Fee refunds do not reduce it (a settlement-fee status, not
// money returned to the debtor).
//
// Pure: no Supabase. The reader in lib/data.ts fetches rows + passes invoices in.

export type RecoveryYTD =
  | { ok: true; totalCents: number; byClientCents: Record<string, number> }
  | { ok: false };

export const RECOVERY_YTD_UNAVAILABLE: RecoveryYTD = { ok: false };

export interface RecoveryLedgerRow {
  id: string;
  source_invoice_id: string | null;
  dollars_recovered: number | string;
  captured_at: string;
}

export interface RecoveryInvoiceRef {
  external_id: string | null;
  client_id: string;
}

// Jan 1 00:00:00Z of `now`'s UTC year (same UTC convention as score refresh).
export function ytdStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
}

// rows + invoices + now → totals in integer cents. A row whose source_invoice_id
// matches no invoice, or an external_id shared by more than one invoice, still
// counts in the total (the authoritative number) but is attributed to no client.
// A non-numeric amount fails closed ({ ok: false }) rather than skew the sum.
export function aggregateRecoveryYTD(
  rows: RecoveryLedgerRow[],
  invoices: RecoveryInvoiceRef[],
  now: Date,
): RecoveryYTD {
  // external_id → client_id; null marks an external_id seen more than once.
  const clientByExternalId = new Map<string, string | null>();
  for (const inv of invoices) {
    if (inv.external_id == null) continue;
    clientByExternalId.set(inv.external_id, clientByExternalId.has(inv.external_id) ? null : inv.client_id);
  }

  const startMs = ytdStart(now).getTime();
  let totalCents = 0;
  const byClientCents: Record<string, number> = {};
  for (const row of rows) {
    if (new Date(row.captured_at).getTime() < startMs) continue;
    const dollars = Number(row.dollars_recovered);
    if (!Number.isFinite(dollars)) {
      console.error("recoveryYTD: non-numeric dollars_recovered on rev_share_ledger row", row.id);
      return RECOVERY_YTD_UNAVAILABLE;
    }
    const cents = Math.round(dollars * 100);
    totalCents += cents;

    const clientId = row.source_invoice_id == null ? undefined : clientByExternalId.get(row.source_invoice_id);
    if (!clientId) {
      console.warn("recoveryYTD: rev_share_ledger row not attributable to a single invoice", row.id);
      continue;
    }
    byClientCents[clientId] = (byClientCents[clientId] ?? 0) + cents;
  }
  return { ok: true, totalCents, byClientCents };
}

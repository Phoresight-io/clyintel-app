// Monthly Settlement Sweep — selection (DB read, service-role).
//
// Returns the rev_share_ledger rows eligible to be swept for a given close
// boundary. Eligible = accrued on/before the boundary, not already folded into a
// settlement, belonging to an active (and, in live mode, non-test) subscriber.
//
// Predicates (from the settlement spec):
//   • rev_share_ledger.cycle_close <= :boundary
//   • id NOT IN (select ledger_row_id from fee_settlement_lines)   -- unlinked = eligible
//                                                                   -- (void releases lines)
//   • subscriber subscription_status = 'active'
//   • subscriber test_user = false           (live; PREVIEW may include test users)
//   • source-agnostic (qbo + stripe_recovery both land here — no source filter)
//
// Uses the service-role client (cross-subscriber; rev_share_ledger is
// service-role-write, and this reads across every subscriber). PostgREST can't
// express `NOT IN (subquery)` directly, so we resolve the linked-id set and the
// active-subscriber set in their own reads and combine in memory.
//
// ROW CAP: PostgREST caps a single response at ~1000 rows, so each of the three
// reads is PAGINATED — we loop `.range(offset, offset+PAGE-1)` until a short/empty
// page and accumulate — otherwise billing rows would be silently dropped at
// volume. Each paged read is `.order()`ed by a stable key so the range windows
// don't overlap or skip rows. (A view/RPC that still returned per-row data would
// hit the same cap; the fix is pagination, not moving the read server-side. If
// the ledger ever gets very large, a future follow-up can push selection +
// per-subscriber aggregation fully into an RPC that returns totals — a smaller
// result set — but that's not needed at current scale.)

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { EligibleLedgerRow } from "./computeSettlements";

/** PostgREST per-response row cap; each read pages in windows of this size. */
export const PAGE = 1000;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Page through EVERY row a query returns. `makePage` builds a fresh query for the
 * given inclusive [from, to] range (a new builder each call — supabase-js query
 * builders are single-use thenables). Stops on the first short page (< PAGE rows).
 */
async function fetchAllRows<T>(
  makePage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  label: string,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  // Guard against an unbounded loop if a stub ever returns full pages forever.
  // 10M rows / 1000 = 10k iterations — far past any real settlement volume.
  for (let guard = 0; guard < 10_000; guard++) {
    const { data, error } = await makePage(from, from + PAGE - 1);
    if (error) {
      throw new Error(`selectEligibleLedgerRows: ${label} read failed: ${error.message}`);
    }
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE) return all; // short/empty page → last page
    from += PAGE;
  }
  throw new Error(`selectEligibleLedgerRows: ${label} exceeded pagination guard`);
}

export interface SelectOptions {
  /** Run close boundary, YYYY-MM-DD. Rows with cycle_close <= this are in scope. */
  boundary: string;
  /** PREVIEW-only escape hatch: include test_user subscribers. Default false (live). */
  includeTestUsers?: boolean;
}

export async function selectEligibleLedgerRows(
  { boundary, includeTestUsers = false }: SelectOptions,
  service: Pick<SupabaseClient, "from"> = getSupabase(),
): Promise<EligibleLedgerRow[]> {
  // 1. Active (and, in live mode, non-test) subscribers — all pages.
  const subs = await fetchAllRows<{ id: string }>((from, to) => {
    let q = service.from("subscribers").select("id").eq("subscription_status", "active");
    if (!includeTestUsers) q = q.eq("test_user", false);
    return q.order("id", { ascending: true }).range(from, to);
  }, "subscribers");
  const activeSubscriberIds = new Set(subs.map((s) => s.id));
  if (activeSubscriberIds.size === 0) return [];

  // 2. Ledger rows already folded into a settlement (any settlement) — excluded. All pages.
  const linked = await fetchAllRows<{ ledger_row_id: string }>(
    (from, to) =>
      service
        .from("fee_settlement_lines")
        .select("ledger_row_id")
        .order("ledger_row_id", { ascending: true })
        .range(from, to),
    "fee_settlement_lines",
  );
  const linkedRowIds = new Set(linked.map((l) => l.ledger_row_id));

  // 3. Ledger rows accrued on/before the boundary (source-agnostic) — all pages.
  type LedgerRow = {
    id: string;
    subscriber_id: string;
    fee_amount: number | string;
    cycle_close: string;
    source: string;
  };
  const ledger = await fetchAllRows<LedgerRow>(
    (from, to) =>
      service
        .from("rev_share_ledger")
        .select("id, subscriber_id, fee_amount, cycle_close, source")
        .lte("cycle_close", boundary)
        .order("id", { ascending: true })
        .range(from, to),
    "rev_share_ledger",
  );

  return ledger
    .filter((r) => activeSubscriberIds.has(r.subscriber_id) && !linkedRowIds.has(r.id))
    .map((r) => ({
      id: r.id,
      subscriberId: r.subscriber_id,
      // fee_amount is numeric; PostgREST may hand it back as number or string.
      feeAmount: Number(r.fee_amount),
      cycleClose: r.cycle_close,
      source: r.source,
    }));
}

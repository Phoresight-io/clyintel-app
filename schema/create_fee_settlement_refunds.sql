-- Migration: create_fee_settlement_refunds
-- Committed 2026-09-17 for review. NOT YET APPLIED to clyintel-dev
-- (mhvuqjryesjsrictesuk) — apply via Supabase MCP after review, then update
-- MIGRATIONS.md with the apply date and regenerate clyintel/types/supabase.ts.
--
-- Part B, refund schema (Prompt 2, schema-only). Records refund/void PROVENANCE
-- for a fee settlement, supporting MULTIPLE partial refunds per settlement (one
-- row per refund attempt). Pairs with alter_fee_settlements_add_refund_statuses
-- (the 'refund_pending'/'refunded' status values). NO execution/webhook/endpoint
-- logic here — those are Prompts 3/4/5.
--
-- Every numeric column is positive-only (amount_cents >= 0), mirroring the house
-- style on fee_settlements.total_fee_cents / fee_settlement_lines.fee_cents:
-- NO negative-capable column. The row's own `status` is the refund ATTEMPT's
-- lifecycle (pending/succeeded/failed), distinct from fee_settlements.status.
--
-- FK note: settlement_id references fee_settlements(id) with NO on-delete cascade
-- (unlike the sibling fee_settlement_lines, which cascades because it is a
-- reconstructable join). A refund row is money/audit provenance and settlements
-- are never hard-deleted (void is a status), so it is intentionally NOT tied to
-- parent deletion.
--
-- Additive + replay-safe (create table / index / trigger all guarded).
-- rev_share_ledger untouched; the five frozen capture/revshare files untouched.

create table if not exists public.fee_settlement_refunds (
  id                     uuid primary key default gen_random_uuid(),
  settlement_id          uuid not null references public.fee_settlements(id),
  -- Stripe refund id (re_...) once the refund call returns; a 'void' of an unpaid
  -- invoice may have no refund id, so this stays nullable until populated.
  stripe_refund_id       text,
  -- 'refund' = money back on a PAID settlement; 'void' = cancel an unpaid invoice.
  kind                   text not null check (kind in ('refund', 'void')),
  -- Positive-only, integer cents; the amount refunded (or voided). Mirrors fee_cents.
  amount_cents           bigint not null check (amount_cents >= 0),
  reason                 text not null,
  -- Who initiated (ops identity string).
  actor                  text not null,
  -- The refund attempt's OWN lifecycle — NOT fee_settlements.status.
  status                 text not null default 'pending'
                           check (status in ('pending', 'succeeded', 'failed')),
  -- Mirrors the charge path's stored idempotency-key pattern (stripe_idempotency_key).
  stripe_idempotency_key text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Fetch all refund rows for a settlement (reconciliation, sum of refunded amount).
create index if not exists idx_fee_settlement_refunds_settlement
  on public.fee_settlement_refunds (settlement_id);

-- updated_at auto-touch — reuse the EXISTING repo convention (public.update_updated_at,
-- the same trigger function fee_settlements / clients use). Not reinvented.
drop trigger if exists trg_fee_settlement_refunds_updated_at on public.fee_settlement_refunds;
create trigger trg_fee_settlement_refunds_updated_at
  before update on public.fee_settlement_refunds
  for each row execute function public.update_updated_at();

-- ── RLS — subscriber-owned read + service-role write (mirror fee_settlements) ──
-- Refund provenance is part of a subscriber's fee billing history, so a subscriber
-- may read their OWN refund rows, but only the settlement/refund worker
-- (service_role, BYPASSRLS) ever writes them. No subscriber_id of its own → scope
-- through the parent settlement with the same EXISTS-through-parent idiom
-- fee_settlement_lines uses. SELECT-only policy; no insert/update/delete policy
-- ⇒ writes stay closed to anon/authenticated. FORCE per rls_hardening_g3.
alter table public.fee_settlement_refunds enable row level security;
alter table public.fee_settlement_refunds force  row level security;

create policy subscriber_isolation_select on public.fee_settlement_refunds
  for select to authenticated
  using (
    exists (
      select 1 from public.fee_settlements s
      where s.id = fee_settlement_refunds.settlement_id
        and s.subscriber_id = auth.uid()
    )
  );

-- ── Rollback (forward-only repo; manual revert) ──────────────────────────────
-- This repo applies migrations forward-only via Supabase MCP (no down files); to
-- revert, drop the table (the trigger and policy drop with it):
--
--   drop table if exists public.fee_settlement_refunds;

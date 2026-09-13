-- Migration: create_fee_settlements
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-09-13.
--
-- Monthly Settlement Sweep — the settlement layer. This is STRICTLY DOWNSTREAM of
-- rev_share_ledger: the ledger stays append-only and is NOT modified here (no
-- billed / billed_at / settlement_id column is added to it). The link between a
-- swept ledger row and the settlement that charged it lives in the join table
-- fee_settlement_lines, keyed by ledger_row_id.
--
-- Two tables:
--   fee_settlements       — one row per (subscriber_id, cycle_close): the fee
--                           invoice/charge for a subscriber's monthly cycle.
--   fee_settlement_lines  — the ledger rows folded into that settlement, with the
--                           per-row fee frozen to integer cents at sweep time.
--
-- RLS posture mirrors ledger_sync / webhook_events exactly: these are INTERNAL
-- tables written only by the settlement worker via the service role (which
-- bypasses RLS). RLS is ENABLED with an explicit deny-all policy for anon +
-- authenticated (the g2 "Deny all access to anon and authenticated" pattern from
-- rls_hardening_g2_deny_all_internal_tables). No subscriber-facing SELECT policy
-- and no FORCE ROW LEVEL SECURITY — matching the internal-queue posture (g3
-- deliberately excludes ledger_sync / webhook_events from FORCE; a deny-all
-- policy already covers anon/authenticated and service_role has BYPASSRLS).
--
-- Additive + replay-safe: create table / index / trigger all guarded, DDL only,
-- no changes to existing tables (rev_share_ledger untouched).

-- ── fee_settlements ──────────────────────────────────────────────────────────
create table if not exists public.fee_settlements (
  id                     uuid primary key default gen_random_uuid(),
  subscriber_id          uuid not null references public.subscribers(id),
  cycle_close            date not null,
  total_fee_cents        bigint not null default 0 check (total_fee_cents >= 0),
  currency               text not null default 'USD',
  status                 text not null default 'pending'
                           check (status in ('pending','invoiced','paid','failed','void')),
  stripe_invoice_id      text,
  stripe_idempotency_key text,
  line_count             int not null default 0 check (line_count >= 0),
  attempts               int not null default 0 check (attempts >= 0),
  max_attempts           int not null default 5,
  last_error             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- One settlement per subscriber per monthly cycle — the real double-charge guard.
create unique index if not exists uq_fee_settlements_subscriber_cycle
  on public.fee_settlements (subscriber_id, cycle_close);
-- Worker claim + reporting lookups.
create index if not exists idx_fee_settlements_status
  on public.fee_settlements (status);
create index if not exists idx_fee_settlements_cycle_close
  on public.fee_settlements (cycle_close);

-- updated_at auto-touch — reuse the EXISTING repo convention (public.update_updated_at,
-- SET search_path TO '', sets NEW.updated_at = now()). Same trigger clients /
-- client_contacts use. Not reinvented. (fee_settlement_lines has no updated_at, so
-- no trigger there.)
drop trigger if exists trg_fee_settlements_updated_at on public.fee_settlements;
create trigger trg_fee_settlements_updated_at
  before update on public.fee_settlements
  for each row execute function public.update_updated_at();

-- ── fee_settlement_lines ─────────────────────────────────────────────────────
-- The join table that keeps rev_share_ledger append-only. fee_cents is the
-- per-ledger-row fee frozen to integer cents at sweep time (rev_share_ledger.fee_amount
-- is numeric DOLLARS); Prompt 2 does the dollars→cents rounding so that
-- sum(fee_cents) == fee_settlements.total_fee_cents reconciles exactly.
create table if not exists public.fee_settlement_lines (
  id            uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.fee_settlements(id) on delete cascade,
  ledger_row_id uuid not null references public.rev_share_ledger(id),
  fee_cents     bigint not null check (fee_cents >= 0),
  created_at    timestamptz not null default now()
);

-- A ledger row can belong to at most ONE settlement. Void handling (Prompt 3)
-- releases rows by DELETING that settlement's lines (FK on delete cascade), so the
-- Prompt-2 selection predicate is simply: ledger rows whose id is NOT IN
-- (select ledger_row_id from fee_settlement_lines).
create unique index if not exists uq_fee_settlement_lines_ledger_row
  on public.fee_settlement_lines (ledger_row_id);
-- Fetch all lines for a settlement (reconciliation, void).
create index if not exists idx_fee_settlement_lines_settlement
  on public.fee_settlement_lines (settlement_id);

-- ── RLS — internal tables, deny-all (mirror ledger_sync / webhook_events) ─────
alter table public.fee_settlements      enable row level security;
alter table public.fee_settlement_lines enable row level security;

create policy "Deny all access to anon and authenticated"
  on public.fee_settlements
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "Deny all access to anon and authenticated"
  on public.fee_settlement_lines
  for all
  to anon, authenticated
  using (false)
  with check (false);

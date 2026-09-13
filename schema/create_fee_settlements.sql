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
-- RLS posture: SUBSCRIBER-OWNED READ + SERVICE-ROLE WRITE. These hold a
-- subscriber's fee billing history, so a subscriber must be able to read their
-- OWN rows — but only the settlement worker (service_role, which has BYPASSRLS)
-- ever writes them. So RLS is ENABLED with a SELECT-only ownership policy and NO
-- insert/update/delete policy for anon/authenticated (writes stay closed), and
-- FORCE ROW LEVEL SECURITY per rls_hardening_g3_force_rls_subscriber_owned.
-- Mapping is the house standard `subscriber_id = auth.uid()` (same as invoices /
-- rev_share_ledger); fee_settlement_lines has no subscriber_id, so it scopes
-- through its parent settlement with the EXISTS idiom invoice_cadence_progress
-- uses. (This replaces the g2 internal deny-all these tables shipped with in the
-- first cut of this migration.)
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

-- ── RLS — subscriber-owned read + service-role write (mirror g3 posture) ──────
alter table public.fee_settlements      enable row level security;
alter table public.fee_settlement_lines enable row level security;

-- FORCE so the policies apply even to an owner-role connection (g3 rationale).
alter table public.fee_settlements      force row level security;
alter table public.fee_settlement_lines force row level security;

-- fee_settlements: subscriber reads their OWN billing history. SELECT-only, same
-- auth→subscriber mapping invoices / rev_share_ledger use. No insert/update/delete
-- policy for authenticated ⇒ writes stay closed; the sweep writes via service_role.
create policy subscriber_isolation_select on public.fee_settlements
  for select to authenticated
  using (subscriber_id = auth.uid());

-- fee_settlement_lines: no subscriber_id of its own, so scope through the parent
-- settlement (mirrors invoice_cadence_progress's EXISTS-through-parent idiom).
create policy subscriber_isolation_select on public.fee_settlement_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.fee_settlements s
      where s.id = fee_settlement_lines.settlement_id
        and s.subscriber_id = auth.uid()
    )
  );

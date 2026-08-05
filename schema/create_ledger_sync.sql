-- Migration: create_ledger_sync
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-08-05.
--
-- D2 Phase 1 — DB-side idempotency substrate for payment writeback (reflect).
--
-- One row per (source_payment_id, provider). The composite UNIQUE is the dedupe
-- grain, mirroring rev_share_ledger's uq_rev_share_ledger_source_payment
-- (source, source_payment_id) — here `provider` plays the discriminator role
-- `source` plays there. The status vocabulary + attempts/last_error columns copy
-- webhook_events exactly (pending/done/failed/dead).
--
-- Retry semantics (enforced by the reflect guard, NOT here): short-circuit on
-- 'done'; 'pending'/'failed' retryable; 'dead' terminal; cap = attempts vs
-- max_attempts (default 5). The retry DRIVER is external (Stripe replay / future
-- worker) — this table is the substrate only.
--
-- RLS posture mirrors webhook_events: internal queue, no owner column, so RLS is
-- ENABLED with NO policies (deny-all non-service; writes flow through the
-- service role only). Additive + replay-safe.

create table if not exists public.ledger_sync (
  id                  uuid primary key default gen_random_uuid(),
  ledger_row_id       uuid not null references public.rev_share_ledger(id),
  source_payment_id   text not null,
  provider            text not null,
  external_payment_id text,
  status              text not null default 'pending' check (status in ('pending','done','failed','dead')),
  attempts            int not null default 0,
  max_attempts        int not null default 5,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists uq_ledger_sync_source_payment_provider
  on public.ledger_sync (source_payment_id, provider);
create index if not exists idx_ledger_sync_status on public.ledger_sync (status);
create index if not exists idx_ledger_sync_ledger_row_id on public.ledger_sync (ledger_row_id);

alter table public.ledger_sync enable row level security;

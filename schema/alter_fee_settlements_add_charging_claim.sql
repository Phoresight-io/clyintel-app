-- Migration: alter_fee_settlements_add_charging_claim
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-09-13.
--
-- Monthly Settlement Sweep (Prompt 4) — single-flight claim for the charge cron.
-- finalize/pay are NOT idempotency-keyed at the invoice level the way item/create
-- are, so two overlapping cron runs must not both act on one settlement. The
-- drainer claims a row by compare-and-set into a transient 'charging' status with
-- a claimed_at timestamp; a stale 'charging' row (claimed_at older than the
-- reclaim timeout — e.g. a crashed run) becomes claimable again. No DB lock is
-- held across the Stripe calls.
--
-- Two additive changes:
--   1. Add 'charging' to the status CHECK (transient state between pending and
--      paid/failed).
--   2. Add claimed_at timestamptz (null until a run claims the row).
-- Additive + replay-safe. rev_share_ledger untouched.

alter table public.fee_settlements drop constraint if exists fee_settlements_status_check;
alter table public.fee_settlements
  add constraint fee_settlements_status_check
  check (status in ('pending', 'charging', 'invoiced', 'paid', 'failed', 'void'));

alter table public.fee_settlements add column if not exists claimed_at timestamptz;

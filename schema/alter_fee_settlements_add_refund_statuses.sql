-- Migration: alter_fee_settlements_add_refund_statuses
-- Committed 2026-09-17 for review. NOT YET APPLIED to clyintel-dev
-- (mhvuqjryesjsrictesuk) — apply via Supabase MCP after review, then update
-- MIGRATIONS.md with the apply date and regenerate clyintel/types/supabase.ts.
--
-- Part B, refund schema (Prompt 2, schema-only). This ONLY makes fee_settlements
-- able to REPRESENT a refund lifecycle. NO refund execution, webhook routing, or
-- ops endpoint here (those are Prompts 3/4/5).
--
-- Extend the fee_settlements status CHECK: the allowed set only GROWS by two
-- values — 'refund_pending' (a refund/void has been initiated, Stripe call not
-- yet reconciled) and 'refunded' (a refund/void has settled). The prior set
-- {pending, charging, invoiced, paid, failed, void} is preserved verbatim; no
-- value is removed and the default ('pending') is unchanged.
--
-- Same drop-and-recreate-the-named-constraint pattern this repo already used to
-- add 'charging' (alter_fee_settlements_add_charging_claim). Additive +
-- replay-safe (drop constraint if exists). No data migration — fee_settlements
-- ships empty (0 rows). rev_share_ledger untouched.

alter table public.fee_settlements drop constraint if exists fee_settlements_status_check;
alter table public.fee_settlements
  add constraint fee_settlements_status_check
  check (status in (
    'pending', 'charging', 'invoiced', 'paid', 'failed', 'void',
    'refund_pending', 'refunded'
  ));

-- ── Rollback (forward-only repo; manual revert) ──────────────────────────────
-- This repo applies migrations forward-only via Supabase MCP (no down files); to
-- revert, restore the pre-refund allowed set. Safe only while no row uses the two
-- new values (fee_settlements is empty today):
--
--   alter table public.fee_settlements drop constraint if exists fee_settlements_status_check;
--   alter table public.fee_settlements
--     add constraint fee_settlements_status_check
--     check (status in ('pending', 'charging', 'invoiced', 'paid', 'failed', 'void'));

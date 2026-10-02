-- Migration: drop_balance_events_fee_eligible
-- Test (clyintel-dev): STEP 1 + STEP 2 APPLIED 2026-10-01 (STEP 2 via the SQL editor;
--   not in the supabase_migrations ledger — see schema/MIGRATIONS.md 2026-10-02).
-- Prod (clyintel-prod): STEP 1 + STEP 2 APPLIED 2026-10-02, in order: (1) add_invoices_outreach_started_at,
--   (2) STEP 1, (3) develop->main release #172, (4) STEP 2 after Prod deployed healthy.
--
-- balance_events.fee_eligible is a write-once flag that nothing reads (it
-- duplicated the billing gate's decision; rev_share_ledger is the source of
-- truth for fees). outreach_had_fired is unchanged.
--
-- TWO STEPS, IN ORDER, per environment (same sequence for Test and Prod).
-- The column is NOT NULL with NO default, so neither a plain drop-first nor a
-- plain deploy-first is safe:
--   * the NEW code omits fee_eligible, so every balance_events insert (QBO sync,
--     capture reconcile) fails until STEP 1 has run;
--   * the OLD code still writes fee_eligible, so inserts fail if STEP 2 runs
--     before the new code is deployed.
--
-- STEP 1 — apply BEFORE deploying this code to the environment.
-- Old code keeps working (it still writes the column); new code may omit it.
alter table public.balance_events alter column fee_eligible drop not null;

-- STEP 2 — apply AFTER this code is deployed AND healthy on the environment.
-- (Run as a separate apply, not together with STEP 1.)
alter table public.balance_events drop column if exists fee_eligible;

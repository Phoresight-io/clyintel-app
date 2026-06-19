-- Migration: add_payments_stripe_event_id_unique
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-06-19.
--
-- DB-enforced idempotency for subscription payment capture: at most one
-- payments row per Stripe event. NULLs remain distinct under a UNIQUE
-- constraint in Postgres, so stripe_event_id stays nullable (rows from other
-- sources without an event id are unaffected). payments verified empty at
-- apply time (0 rows), so no existing-data violation.
--
-- Replay-safe: only adds the constraint if it isn't already present.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_stripe_event_id_key'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_stripe_event_id_key UNIQUE (stripe_event_id);
  END IF;
END $$;

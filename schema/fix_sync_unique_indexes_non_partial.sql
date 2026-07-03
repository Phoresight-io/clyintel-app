-- Migration: fix_sync_unique_indexes_non_partial
-- Corrects add_clients_source_and_sync_unique_indexes. Those indexes were
-- created PARTIAL (WHERE external_id IS NOT NULL), but a column-only
-- `ON CONFLICT (subscriber_id, source, external_id)` — which supabase-js
-- .upsert({ onConflict }) emits, with no way to pass the index predicate —
-- cannot use a partial index as its conflict arbiter (Postgres error 42P10).
-- That makes the QBO sync upsert (/api/qbo/sync) impossible.
--
-- Fix: recreate the indexes WITHOUT the partial predicate. The predicate was
-- unnecessary anyway — a standard unique index already treats NULLs as
-- distinct, so manual rows with a null external_id still never collide. This is
-- purely an index swap: no columns, constraints, or data change.

DROP INDEX IF EXISTS public.clients_subscriber_source_external_uq;
DROP INDEX IF EXISTS public.invoices_subscriber_source_external_uq;

CREATE UNIQUE INDEX clients_subscriber_source_external_uq
  ON public.clients (subscriber_id, source, external_id);

CREATE UNIQUE INDEX invoices_subscriber_source_external_uq
  ON public.invoices (subscriber_id, source, external_id);

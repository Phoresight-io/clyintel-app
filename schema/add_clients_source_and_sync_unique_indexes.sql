-- Migration: add_clients_source_and_sync_unique_indexes
-- Unblocks the QBO sync route (/api/qbo/sync). The route upserts clients then
-- invoices idempotently by (subscriber_id, source, external_id), but today:
--   1. clients has no `source` column (only invoices does), and
--   2. neither table has a unique index on (subscriber_id, source, external_id)
--      to back an ON CONFLICT upsert.
-- This migration adds both. Purely additive: a new column with a default and
-- two new partial unique indexes; no data rewrite, no changes to existing
-- columns, constraints, or other tables.

-- clients: add source (mirrors invoices.source), backfill existing rows to 'manual'
ALTER TABLE public.clients
  ADD COLUMN source text NOT NULL DEFAULT 'manual';

-- Per-subscriber uniqueness: QBO external_id is only unique within a realm,
-- so scope the conflict target by subscriber_id. Partial (external_id NOT NULL)
-- so manual rows with null external_id don't collide.
CREATE UNIQUE INDEX clients_subscriber_source_external_uq
  ON public.clients (subscriber_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX invoices_subscriber_source_external_uq
  ON public.invoices (subscriber_id, source, external_id)
  WHERE external_id IS NOT NULL;

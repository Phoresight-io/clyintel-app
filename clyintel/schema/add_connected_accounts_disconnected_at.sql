-- Migration: add_connected_accounts_disconnected_at
-- Off-Platform Reconciliation — T1 (integration foundation).
--
-- Adds a nullable lifecycle timestamp so a provider connection can be SOFT-VOIDED
-- (tokens + external_id nulled, row kept for audit) rather than hard-deleted.
-- Used by POST /api/qbo/disconnect. NULL = never disconnected; a timestamp records
-- the most recent disconnect. "Currently connected" is still derived from
-- external_id / access_token being present (a reconnect repopulates those), so no
-- existing read path changes behavior from this column alone.

alter table public.connected_accounts
  add column if not exists disconnected_at timestamptz;

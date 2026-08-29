-- Migration: add_payment_link_url_to_subscribers_and_clients
-- Path B foundation (Brick A) — persistent payment link on both the subscriber
-- (account-level default) and the client (per-payer override).
--
-- Additive, nullable, no default, no backfill: NULL = no link set. Existing read
-- paths are unaffected until a later brick reads the column. RLS is row-level on
-- both tables (subscriber_isolation), so this column inherits it — no policy change.

alter table public.subscribers
  add column if not exists payment_link_url text;

alter table public.clients
  add column if not exists payment_link_url text;

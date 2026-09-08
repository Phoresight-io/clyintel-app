-- Migration: add_name_to_client_contacts
-- Contacts Fix 2a — additive schema for contact person-name.
--
-- Adds a nullable `name` column to client_contacts so outreach can greet the
-- PERSON reached (the recipient contact) rather than the CLIENT (company, from
-- clients.name / QBO DisplayName). The name is:
--   • DEFERRED for PoC contacts — this migration does NOT backfill and does NOT
--     wire QBO person-name sourcing (GivenName/FamilyName). Existing PoC rows keep
--     name=null, so the send-path greeting falls back to the company name — no
--     regression from today's behavior.
--   • user-entered for DUNNING contacts via the editor (Fix 2b).
--
-- ADDITIVE ONLY. Nullable, no default, no backfill, no index, no constraint, no
-- RLS change. `role` (nullable text, unused) is deliberately NOT reused — a
-- contact's person-name is distinct from a role label.
--
-- APPLY: Charles applies via Supabase MCP apply_migration
-- (name: add_name_to_client_contacts) AFTER review — same pattern as
-- create_client_contacts / add_contact_type_and_channel_ranks_to_client_contacts.
-- Do NOT auto-apply. types/supabase.ts must be regenerated AFTER apply
-- (follow-up Fix 2a-types, which gates Fix 2b).

-- ── Column (additive, nullable) ──────────────────────────────────────────────
-- Idempotent: `if not exists` makes a re-run a clean no-op.
alter table public.client_contacts
  add column if not exists name text;

-- ── NOT done here (deliberate) ───────────────────────────────────────────────
-- No backfill (existing rows stay name=null). No QBO person-name sourcing. No
-- index/constraint. `role`, contact_type, ranks, opt_out_* untouched.

-- Migration: add_contact_type_and_channel_ranks_to_client_contacts
-- Contacts Subsystem Brick 0 — additive schema for Decision Record D3.
--
-- Adds the contact KIND (poc | dunning) and PER-CHANNEL rank columns to
-- client_contacts, then backfills the existing rows (all QBO PoC primaries).
-- Ranking is per (contact, channel): email_rank / sms_rank / voice_rank are
-- independent, null = the contact does not participate in that channel.
--
-- ADDITIVE + BACKFILL ONLY. is_primary is NOT dropped here and the existing
-- client_contacts_one_primary_per_client index is NOT touched — retiring
-- is_primary is a LATER brick, after the send path and QBO sync move off it.
--
-- APPLY: Charles applies via Supabase MCP apply_migration
-- (name: add_contact_type_and_channel_ranks_to_client_contacts) AFTER review —
-- same pattern as create_client_contacts / create_cadence_engine. Do NOT
-- auto-apply. types/supabase.ts must be regenerated AFTER apply (follow-up, not
-- this brick).
--
-- Verified pre-apply (via MCP): 29 contacts, exactly one per client, every one
-- carries email + phone, no client has >1 contact — so the per-channel rank
-- backfill (all rank=1) cannot violate the new one-per-(client,channel) unique
-- indexes.

-- ── 1. Columns (additive, nullable) ─────────────────────────────────────────
-- contact_type: 'poc' (address of record, QBO-sourced) | 'dunning' (user-added,
-- ranked). Nullable + CHECK that ALLOWS NULL so the ALTER cannot fail on the
-- pre-backfill rows; the backfill (step 2) fills every existing row, and future
-- rows are app-enforced to a non-null value. The CHECK still rejects any value
-- outside the set even while null is permitted transitionally.
alter table public.client_contacts
  add column if not exists contact_type text,
  add column if not exists email_rank   integer,
  add column if not exists sms_rank     integer,
  add column if not exists voice_rank   integer;

-- Idempotent CHECK add (ADD CONSTRAINT has no IF NOT EXISTS; guard via catalog).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'client_contacts_contact_type_check'
      and conrelid = 'public.client_contacts'::regclass
  ) then
    alter table public.client_contacts
      add constraint client_contacts_contact_type_check
      check (contact_type in ('poc', 'dunning'));  -- NULL passes a CHECK, so null stays allowed transitionally
  end if;
end $$;

-- ── 2. Backfill existing rows (all are QBO PoC primaries) ────────────────────
-- Idempotent predicate: only rows not yet typed. Re-running is a clean no-op
-- (once contact_type is set, the WHERE excludes the row — no double-apply, no
-- error). All current rows are the single is_primary PoC per client, so they
-- become contact_type='poc' with rank 1 on every channel.
update public.client_contacts set
  contact_type = 'poc',
  email_rank   = 1,
  sms_rank     = 1,
  voice_rank   = 1
where contact_type is null;

-- ── 3. Per-channel "one Primary per channel per client" partial unique indexes ─
-- The real invariant: within a client, at most one contact holds a given rank on
-- a given channel (so rank 1 = the Primary for that channel). Partial (WHERE rank
-- IS NOT NULL) so contacts that don't participate in a channel (null rank) are
-- exempt. Safe on the backfilled data: one contact per client ⇒ no collision.
create unique index if not exists client_contacts_email_rank_unique
  on public.client_contacts (client_id, email_rank)
  where email_rank is not null;

create unique index if not exists client_contacts_sms_rank_unique
  on public.client_contacts (client_id, sms_rank)
  where sms_rank is not null;

create unique index if not exists client_contacts_voice_rank_unique
  on public.client_contacts (client_id, voice_rank)
  where voice_rank is not null;

-- ── NOT done here (deliberate) ───────────────────────────────────────────────
-- is_primary NOT dropped; client_contacts_one_primary_per_client NOT dropped;
-- role untouched; opt_out_email/sms/voice untouched.

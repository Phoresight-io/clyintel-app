-- Migration: create_client_contacts
-- Brick 0a — client_contacts table + primary-contact backfill (DATA ONLY).
--
-- Introduces a per-client contacts table that will become the future authority
-- for who ClyIntel reaches out to. This PR is DATA-ONLY: no app code reads
-- client_contacts yet — clients.email / phone / opt_out_* stay authoritative.
-- The backfill seeds exactly one is_primary contact per emailed client (29 of
-- 30; the 1 email-less client intentionally gets none), carrying that client's
-- current email, phone, and opt-out state forward UNCHANGED.

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.client_contacts (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references public.clients(id) on delete cascade,
  email         text,
  phone         text,
  is_primary    boolean     not null default false,
  role          text,
  opt_out_email boolean     not null default false,
  opt_out_sms   boolean     not null default false,
  -- opt_out_voice included now even though clients has no such column yet: this
  -- table is the future authority, so we avoid migrating it twice.
  opt_out_voice boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Exactly one primary contact per client (partial unique index).
create unique index if not exists client_contacts_one_primary_per_client
  on public.client_contacts (client_id)
  where is_primary;

-- Lookup by parent client.
create index if not exists client_contacts_client_id_idx
  on public.client_contacts (client_id);

-- ── updated_at auto-touch — reuse the EXISTING repo convention ───────────────
-- Same trigger function clients uses: public.update_updated_at() (SET search_path
-- TO '', sets NEW.updated_at = now()). Not reinvented.
drop trigger if exists trg_client_contacts_updated_at on public.client_contacts;
create trigger trg_client_contacts_updated_at
  before update on public.client_contacts
  for each row execute function public.update_updated_at();

-- ── RLS — mirror clients' subscriber_isolation, scoped via the client_id join ─
-- clients has: policy "subscriber_isolation" FOR ALL USING (subscriber_id =
-- auth.uid()). client_contacts has no subscriber_id, so we reach it through the
-- FK join. WITH CHECK is stated explicitly with the same predicate (clients
-- relies on the implicit reuse of USING) so a write can never attach a contact to
-- another subscriber's client — equal strictness, not looser.
alter table public.client_contacts enable row level security;

drop policy if exists "subscriber_isolation" on public.client_contacts;
create policy "subscriber_isolation"
  on public.client_contacts
  for all
  using (
    exists (
      select 1 from public.clients c
      where c.id = client_contacts.client_id
        and c.subscriber_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.clients c
      where c.id = client_contacts.client_id
        and c.subscriber_id = auth.uid()
    )
  );

-- ── Backfill — one primary contact per emailed client ────────────────────────
-- Idempotent: the NOT EXISTS guard skips any client that already has a primary,
-- so re-running inserts nothing. Preserves each client's current opt-out state
-- (does NOT reset to false). Email-less clients get no row. opt_out_voice has no
-- source column on clients, so it takes the table default (false).
insert into public.client_contacts (client_id, email, phone, is_primary, opt_out_email, opt_out_sms)
select c.id, c.email, c.phone, true, c.opt_out_email, c.opt_out_sms
from public.clients c
where c.email is not null
  and btrim(c.email) <> ''
  and not exists (
    select 1 from public.client_contacts cc
    where cc.client_id = c.id and cc.is_primary
  );

-- ── Account-attention flag on clients — DATA-ONLY (no derivation this PR) ─────
-- Single nullable reason column: non-null = the account needs attention, and the
-- value records WHY. One source of truth (a separate boolean would be derivable
-- from this and could drift). Left nullable with no backfill — derivation wires
-- up in Brick 0b. Kept as text (not an enum) so 0b can settle the reason set
-- before it's frozen into a type.
alter table public.clients
  add column if not exists attention_reason text;

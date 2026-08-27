-- Migration: create_cadence_engine
-- Brick 1c — cadence-as-data model + per-invoice progress substrate.
--
-- Introduces the tables the trigger engine (lib/outreach/runCadence.ts) walks:
-- a cadence DEFINITION (an ordered set of steps) and a per-invoice PROGRESS log
-- that is also the idempotency substrate. No app code sends anything; the engine
-- calls sendEmailStep in dry-run only. This migration registers NO cron.
--
-- APPLY: Charles applies via Supabase MCP AFTER review (same pattern as
-- create_client_contacts / seed_system_default_email_template). Do NOT auto-apply.
--
-- ⚠️ AGENT-2-OWNED PLACEHOLDER — NON-NEGOTIABLE ⚠️
-- The SEEDED cadence below (one email step at entry, offset 0) is a placeholder so
-- the engine has *something* to walk before Agent 2 exists. The cadence SHAPE —
-- touch count, intervals, channel mix, aggression — is AGENT 2's output, weighted
-- by Client Score. Agent 1 (this engine) is the dumb executor that walks whatever
-- cadence it is handed. Do NOT read the seeded step values (count=1, offset=0,
-- channel=email) as a settled product decision. These tables are expressive enough
-- to hold a real multi-step cadence; they encode NO judgment about what it should be.

-- ── Cadence definition header (GLOBAL reference data, not subscriber-scoped) ──
-- Like the system-default email template, a cadence definition is global. Agent 2
-- will later select/produce per-client cadences; that per-client dimension is
-- Agent 2's territory and deliberately absent here.
create table if not exists public.cadences (
  id         uuid        primary key default gen_random_uuid(),
  key        text        not null unique,   -- stable identifier the engine can pin
  name       text        not null,
  is_active  boolean     not null default true,
  created_at timestamptz not null default now()
);

-- ── Ordered steps of a cadence ───────────────────────────────────────────────
-- Each step is {step_number, channel, offset_business_days_from_entry}. The engine
-- walks steps in ascending step_number and computes each step's due date as
-- offset_business_days after the cadence ENTRY date (see runCadence.ts). Nothing
-- here is aggression/interval judgment — those values are Agent 2's to set.
create table if not exists public.cadence_steps (
  id                   uuid    primary key default gen_random_uuid(),
  cadence_id           uuid    not null references public.cadences(id) on delete cascade,
  step_number          int     not null check (step_number >= 1),
  channel              public.communication_channel not null,
  offset_business_days int     not null default 0 check (offset_business_days >= 0),
  created_at           timestamptz not null default now(),
  unique (cadence_id, step_number)
);

create index if not exists cadence_steps_cadence_id_idx
  on public.cadence_steps (cadence_id, step_number);

-- ── Per-invoice cadence progress — the idempotency substrate ──────────────────
-- One row per (invoice, step) the engine has recorded. THE unique(invoice_id,
-- step_number) index IS the guard: a step already recorded is never re-run, and no
-- separate dedup table exists. Append-only log (no updated_at). subscriber_id is
-- carried directly so RLS matches the recovery_attempts / communications shape.
create table if not exists public.invoice_cadence_progress (
  id                  uuid        primary key default gen_random_uuid(),
  subscriber_id       uuid        not null references public.subscribers(id) on delete cascade,
  invoice_id          uuid        not null references public.invoices(id) on delete cascade,
  cadence_id          uuid        not null references public.cadences(id),
  step_number         int         not null,
  -- Links to the dry-run artifacts sendEmailStep produced for this step (nullable
  -- so the log survives even if those rows are later pruned).
  communication_id    uuid        references public.communications(id) on delete set null,
  recovery_attempt_id uuid        references public.recovery_attempts(id) on delete set null,
  recorded_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (invoice_id, step_number)   -- idempotency guard
);

create index if not exists invoice_cadence_progress_invoice_idx
  on public.invoice_cadence_progress (invoice_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Definition tables are global read-only reference data (writes via service role /
-- migration only). RLS enabled to satisfy the security advisor; authenticated may
-- read so a future UI can show the cadence.
alter table public.cadences enable row level security;
drop policy if exists "read_cadences" on public.cadences;
create policy "read_cadences" on public.cadences for select using (true);

alter table public.cadence_steps enable row level security;
drop policy if exists "read_cadence_steps" on public.cadence_steps;
create policy "read_cadence_steps" on public.cadence_steps for select using (true);

-- Progress rows are subscriber-scoped — mirror clients' subscriber_isolation. The
-- WITH CHECK is stated explicitly (equal strictness) AND additionally verifies the
-- invoice belongs to the same subscriber, so a row can never attach progress to
-- another subscriber's invoice.
alter table public.invoice_cadence_progress enable row level security;
drop policy if exists "subscriber_isolation" on public.invoice_cadence_progress;
create policy "subscriber_isolation"
  on public.invoice_cadence_progress
  for all
  using (subscriber_id = auth.uid())
  with check (
    subscriber_id = auth.uid()
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_cadence_progress.invoice_id
        and i.subscriber_id = auth.uid()
    )
  );

-- ── Seed ONE flat default cadence (the Agent-2 placeholder) ──────────────────
-- Idempotent via NOT EXISTS on the stable key. Single email step at entry.
insert into public.cadences (key, name, is_active)
select 'default_v1', 'Default flat cadence (Agent-2 placeholder)', true
where not exists (select 1 from public.cadences where key = 'default_v1');

insert into public.cadence_steps (cadence_id, step_number, channel, offset_business_days)
select c.id, 1, 'email', 0
from public.cadences c
where c.key = 'default_v1'
  and not exists (
    select 1 from public.cadence_steps s
    where s.cadence_id = c.id and s.step_number = 1
  );

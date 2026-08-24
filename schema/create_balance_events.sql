-- Migration: create_balance_events
-- Off-Platform Reconciliation — Step 1.
--
-- Adds the balance_events table: one row per detected DROP in an invoice's
-- outstanding balance (a payment we did not process on-platform). The fee
-- engine (rev_share_ledger, reused — no sibling fee table) links back to the
-- triggering event via rev_share_ledger.balance_event_id.
--
-- capture_sources is NOT seeded here: the registry already holds 'qbo' and
-- 'stripe_recovery' (see capture_detection_phase1 / seed_capture_source_*).
-- balance_events.source FK-references that existing registry; the beta QBO
-- sync writes 'qbo'. Other adapters seed their own rows in later migrations.

create table public.balance_events (
  id                      uuid primary key default gen_random_uuid(),
  subscriber_id           uuid not null references public.subscribers(id),
  invoice_id              uuid not null references public.invoices(id),
  source                  text not null references public.capture_sources(id),
  prev_outstanding_cents  bigint not null,
  new_outstanding_cents   bigint not null,
  delta_cents             bigint not null,
  outreach_had_fired      boolean not null,  -- (reminder_count > 0) at emission time
  fee_eligible            boolean not null,  -- = outreach_had_fired for beta
  evidence                jsonb,
  detected_at             timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  -- A balance_event is only ever a DROP: new outstanding must be strictly less
  -- than prev. Same-value / increase emissions are rejected.
  constraint balance_events_is_drop
    check (new_outstanding_cents < prev_outstanding_cents),
  -- delta_cents must equal the drop it claims to represent.
  constraint balance_events_delta_matches
    check (delta_cents = prev_outstanding_cents - new_outstanding_cents)
);

create index balance_events_invoice_detected_idx
  on public.balance_events (invoice_id, detected_at desc);

alter table public.balance_events enable row level security;

-- Subscriber isolation on SELECT — mirrors rev_share_ledger.subscriber_isolation_select.
create policy subscriber_isolation_select
  on public.balance_events
  for select to public
  using (subscriber_id = auth.uid());

alter table public.rev_share_ledger
  add column balance_event_id uuid unique references public.balance_events(id);

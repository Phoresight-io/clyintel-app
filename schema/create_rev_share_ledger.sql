-- Migration: create_rev_share_ledger
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-06-28.
--
-- Persistence layer behind the D2 accrual ledger. Rows are written only by the
-- service role (the future detection job), which bypasses RLS. Table ships
-- EMPTY (no seed); D2's BillingTab stays on mock data until detection exists.
--
-- RLS deviation (intentional, required): subscriber_isolation read expression
-- matches the house pattern, but this is a SELECT-only policy — NOT cmd ALL.
-- A billing ledger must let a subscriber read their own rows while never
-- inserting/updating/deleting them. No write policy is added for authenticated
-- users by design; writes flow exclusively through the service role.

create table public.rev_share_ledger (
  id                  uuid primary key default gen_random_uuid(),
  subscriber_id       uuid not null references public.subscribers(id),
  invoice_ref         text not null,
  invoice_face_value  numeric(12,2) not null check (invoice_face_value >= 0),
  dollars_recovered   numeric(12,2) not null check (dollars_recovered >= 0),
  band                text not null,
  rate                numeric(5,4) not null check (rate >= 0 and rate <= 1),
  fee_amount          numeric(12,2) not null check (fee_amount >= 0),
  captured_at         timestamptz not null,
  cycle_close         date not null,
  engine_version      text,
  created_at          timestamptz not null default now()
);

create index idx_rev_share_ledger_subscriber_cycle on public.rev_share_ledger (subscriber_id, cycle_close);
create index idx_rev_share_ledger_invoice_ref on public.rev_share_ledger (invoice_ref);

alter table public.rev_share_ledger enable row level security;
create policy subscriber_isolation_select on public.rev_share_ledger for select using (subscriber_id = auth.uid());

-- 1a: capture_sources registry
create table public.capture_sources (
  id           text primary key,
  display_name text not null,
  kind         text not null,
  active       boolean not null default true,
  config       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
alter table public.capture_sources enable row level security;
create policy capture_sources_select_authenticated
  on public.capture_sources for select
  to authenticated
  using (auth.role() = 'authenticated');
insert into public.capture_sources (id, display_name, kind)
values ('qbo', 'QuickBooks Online', 'native_adapter');
alter table public.rev_share_ledger
  add column source            text references public.capture_sources(id),
  add column source_payment_id text,
  add column source_invoice_id text;
create unique index uq_rev_share_ledger_source_payment
  on public.rev_share_ledger (source, source_payment_id);

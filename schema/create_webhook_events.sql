-- Migration: create_webhook_events
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-07-01.
--
-- Generic, durable webhook-event queue behind D2 capture. Any verified inbound
-- webhook body is persisted here first, then drained asynchronously by the
-- worker, which routes on `source` (a capture_sources registry slug, e.g.
-- 'qbo'). Persist-then-process makes delivery durable: a crash mid-processing
-- leaves the row claimable again.
--
-- RLS posture mirrors rev_share_ledger: writes flow exclusively through the
-- service role (webhook route + worker), which bypasses RLS. No anon/
-- authenticated write policy exists by design. Unlike rev_share_ledger there is
-- no subscriber-facing read either — this is an internal queue with no owner
-- column — so RLS is enabled with NO policies, denying all non-service access.

create table public.webhook_events (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,
  raw_payload   jsonb not null,
  signature     text,
  status        text not null default 'pending' check (status in ('pending','done','failed','dead')),
  attempts      int not null default 0,
  last_error    text,
  result        text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

create index idx_webhook_events_status on public.webhook_events (status);

alter table public.webhook_events enable row level security;

-- Migration: create_voice_call_events
-- Raw audit trail for inbound Vapi webhook events (voice debugging).
--
-- Every event POSTed to app/api/voice/webhook is persisted here BEFORE the
-- correlation/update logic runs, so we can see the exact payload shape Vapi
-- sends and whether it resolved to a voice_calls row. This exists because
-- end-of-call/status-update events were ACKing 200 without ever updating a
-- voice_calls row — capturing the raw body is the only reliable way to confirm
-- the real field paths and the match outcome in production.
--
-- Columns:
--   raw                    — the full parsed webhook body (source of truth)
--   event_type             — message.type, when present
--   vapi_call_id           — the Vapi call id extracted from the event
--   matched_voice_call_id  — the voice_calls row we resolved, or NULL if none
--
-- Service-role ONLY: RLS is enabled with NO policy, so anon/auth roles cannot
-- read or write it; the webhook writes via the service-role client (which
-- bypasses RLS), same pattern as webhook_events. Additive, no FK on
-- matched_voice_call_id (kept loose so an unmatched/garbage id still records).
--
-- APPLY: Charles applies via Supabase MCP apply_migration
-- (name: create_voice_call_events) AFTER review — same pattern as
-- create_webhook_events / create_client_contacts. Do NOT auto-apply.
-- types/supabase.ts carries a hand-added voice_call_events entry so the webhook
-- compiles now; regenerate the types after apply to reconcile.

-- ── Table (idempotent) ───────────────────────────────────────────────────────
create table if not exists public.voice_call_events (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  event_type text,
  vapi_call_id text,
  matched_voice_call_id uuid,
  raw jsonb not null
);

-- ── RLS: locked to service-role (enabled, NO policy) ─────────────────────────
alter table public.voice_call_events enable row level security;

-- ── Index for time-ordered inspection ────────────────────────────────────────
create index if not exists voice_call_events_received_at_idx
  on public.voice_call_events (received_at);

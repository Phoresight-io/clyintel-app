-- Migration: add_invoices_outreach_started_at
-- NOT YET APPLIED — deliver for review; Charles applies to clyintel-dev, then prod.
--
-- ⚠️ PER-DATABASE INPUT. Before EACH apply, replace the ONE placeholder
--    __VAPI_ASSISTANT_ID_TEST__   (in the `_mig_outreach_cfg` insert below)
-- with THAT database's environment value of VAPI_ASSISTANT_ID_TEST
-- (Test: clyintel-dev / mhvuqjryesjsrictesuk; Prod: clyintel-prod / ftttyxknwwrlfsqxntxr).
-- If the two environments use different test assistants, the file is edited
-- separately for each apply. The guard aborts the WHOLE migration (nothing written)
-- if the placeholder is still in place. Do not commit the edited copy.
--
-- One shared "outreach started" marker on the invoice. LOCKED RULE: if outreach
-- on ANY channel started on the invoice before the payment, the payment is
-- billable; otherwise it is not. No time window.
--
-- 1. voice_calls.is_test (boolean NOT NULL DEFAULT false). The voice route writes
--    it from the request's test flag from now on. Backfilled TRUE for calls placed
--    with the test assistant. Test calls are never outreach — nor are emails sent
--    from inside one (voice_calls.handoff_email_communication_id → communications.id
--    is the only link between an in-call email and its call).
--
-- 2. invoices.outreach_started_at (timestamptz NULL). Write-once: the app stamps it
--    with  UPDATE invoices SET outreach_started_at = <ts>
--          WHERE id = <invoice> AND outreach_started_at IS NULL
--    (lib/outreach/markOutreachStarted.ts) at the first REAL contact:
--      email — a live send MailerSend accepted (communications.status = 'sent'
--              with a mailersend_message_id), unless sent from inside a test call;
--      voice — a non-test call Vapi accepted (vapi_call_id + started_at set);
--      sms   — no real send path exists yet (stamp point marked in code).
--    Backfill = the EARLIEST of those real-contact signals per invoice.
--    recovery_attempts is deliberately NOT read: it holds the Brick-A SIMULATION
--    rows (notes = 'SIMULATION—BRICK-A-V1—NO_REAL_SEND', sent_at set, no send),
--    which must never count as outreach.
--
-- reminder_count / last_reminder_at are left untouched.
-- Additive + replay-safe: `add column if not exists`; both backfills only move
-- rows still at their default (is_test false → true; outreach_started_at NULL →
-- ts), so an already-stamped invoice is never moved.

-- ── Per-database input + guard ──────────────────────────────────────────────
create temp table _mig_outreach_cfg (test_assistant_id text not null);
insert into _mig_outreach_cfg values ('__VAPI_ASSISTANT_ID_TEST__');

do $$
begin
  if exists (select 1 from _mig_outreach_cfg
             where test_assistant_id like '\_\_%' or btrim(test_assistant_id) = '') then
    raise exception 'add_invoices_outreach_started_at: set this database''s VAPI_ASSISTANT_ID_TEST in _mig_outreach_cfg before applying';
  end if;
end $$;

-- ── 1. voice_calls.is_test ──────────────────────────────────────────────────
alter table public.voice_calls
  add column if not exists is_test boolean not null default false;

comment on column public.voice_calls.is_test is
  'True for a test-mode call (test assistant). Test calls, and emails sent from inside them, never count as outreach.';

update public.voice_calls v
set is_test = true
from _mig_outreach_cfg cfg
where v.assistant_id = cfg.test_assistant_id
  and v.is_test = false;

-- ── 2. invoices.outreach_started_at ─────────────────────────────────────────
alter table public.invoices
  add column if not exists outreach_started_at timestamptz;

comment on column public.invoices.outreach_started_at is
  'Write-once: first real outreach on any channel (email accepted by MailerSend, '
  'non-test voice call accepted by Vapi; never an email sent from inside a test call). '
  'Drives fee eligibility. Never set from recovery_attempts.';

with real_contact as (
  -- (a) email accepted by MailerSend, excluding emails sent from inside a test call
  select c.invoice_id, c.sent_at as ts
  from public.communications c
  where c.status = 'sent'
    and c.mailersend_message_id is not null
    and c.invoice_id is not null
    and c.sent_at is not null
    and not exists (
      select 1 from public.voice_calls tv
      where tv.handoff_email_communication_id = c.id
        and tv.is_test
    )
  union all
  -- (b) non-test voice call accepted by Vapi
  select v.invoice_id, v.started_at as ts
  from public.voice_calls v
  where v.vapi_call_id is not null
    and v.started_at is not null
    and v.invoice_id is not null
    and not v.is_test
),
first_contact as (
  select invoice_id, min(ts) as ts
  from real_contact
  group by invoice_id
)
update public.invoices i
set outreach_started_at = f.ts
from first_contact f
where i.id = f.invoice_id
  and i.outreach_started_at is null;

drop table _mig_outreach_cfg;

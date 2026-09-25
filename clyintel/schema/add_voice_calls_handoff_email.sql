-- Voice → email handoff: at-most-once payment-link email per call.
--
-- NOT APPLIED by the PR that adds it. Chat applies it to Test
-- (mhvuqjryesjsrictesuk) via apply_migration after merge, then reads it back.
--
-- The end-of-call-report webhook (app/api/voice/webhook) claims a call before
-- sending with a conditional transition from NULL:
--   update voice_calls set handoff_email_status = 'claimed', handoff_email_at = now()
--   where id = $1 and handoff_email_status is null
-- 0 rows means another delivery already owns the call, so nothing is sent. A skip
-- uses the same NULL-guarded write (→ 'skipped' + reason), so a replayed delivery
-- can never send later. 'failed' is terminal; nothing retries automatically.
--
-- No default and no backfill: existing rows stay NULL. With
-- VOICE_HANDOFF_EMAIL_MODE unset (the default), nothing reads or writes these
-- columns, so merging before this is applied is inert.

alter table public.voice_calls
  add column handoff_email_status text,
  add column handoff_email_reason text,
  add column handoff_email_communication_id uuid references public.communications(id) on delete set null,
  add column handoff_email_at timestamptz,
  add constraint voice_calls_handoff_email_status_chk check (
    handoff_email_status is null
    or handoff_email_status in ('claimed', 'would_send', 'sent', 'skipped', 'failed')
  );

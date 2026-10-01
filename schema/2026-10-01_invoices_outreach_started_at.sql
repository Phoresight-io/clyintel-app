-- Migration: invoices_outreach_started_at
-- Fee-gate fix (locked rules, Charles 2026-09-30). NOT YET APPLIED — chat applies
-- after merge (Test first, then Prod before the release that ships the code).
--
-- Adds the write-once outreach marker the fee gate reads:
--   rev_share_ledger fee only if outreach STARTED on the invoice BEFORE the
--   payment (QBO Payment MetaData.CreateTime, else TxnDate by UTC date).
--
-- Written at runtime (write-once: `... where outreach_started_at is null`) by:
--   - lib/outreach/sendEmailStep.ts  live send succeeded with a MailerSend id
--   - app/api/voice/call/route.ts    Vapi 200 with a call id (call placed)
-- via lib/outreach/markOutreachStarted.ts.
--
-- NOT the existing (unused) invoices.recovery_started_at — that column is left
-- untouched.
--
-- Additive + replay-safe: `add column if not exists`; the backfill only fills
-- NULLs, so re-running it changes nothing. No index (read by primary-key row).
-- Never reads recovery_attempts: Brick-A SIMULATION rows carry sent_at with no
-- real send and must never count as outreach.

alter table public.invoices
  add column if not exists outreach_started_at timestamptz;

comment on column public.invoices.outreach_started_at is
  'Write-once: first real outreach on this invoice (live email sent with a MailerSend id, or a placed Vapi call). Fee gate: fee only if this precedes the payment. Never from SIMULATION recovery_attempts.';

-- Backfill (idempotent, NULLs only): earliest qualifying outreach per invoice.
--   email: communications outbound, status 'sent', mailersend_message_id set → sent_at
--   voice: voice_calls with vapi_call_id set → started_at (else created_at)
-- Tenant-matched: the source row's subscriber_id must equal the invoice's.
with src as (
  select c.subscriber_id, c.invoice_id, c.sent_at as ts
    from public.communications c
   where c.direction = 'outbound'
     and c.status = 'sent'
     and c.mailersend_message_id is not null
     and c.sent_at is not null
     and c.invoice_id is not null
  union all
  select v.subscriber_id, v.invoice_id, coalesce(v.started_at, v.created_at) as ts
    from public.voice_calls v
   where v.vapi_call_id is not null
     and v.invoice_id is not null
),
firsts as (
  select subscriber_id, invoice_id, min(ts) as ts
    from src
   group by subscriber_id, invoice_id
)
update public.invoices i
   set outreach_started_at = f.ts
  from firsts f
 where i.id = f.invoice_id
   and i.subscriber_id = f.subscriber_id
   and i.outreach_started_at is null;

-- Post-apply read-back (expected on Test as of 2026-10-01: 2 rows —
-- inv 1036 → 2026-09-10 04:52:22.947+00, inv 1010 → 2026-09-26 21:47:01.611+00):
--   select invoice_number, external_id, outreach_started_at
--     from public.invoices where outreach_started_at is not null order by 3;

-- Migration: seed_system_default_email_template
-- Brick 1a — seed ONE global system-default email template so the recorded send
-- step (lib/outreach/sendEmailStep.ts) has copy to render.
--
-- subscriber_id is NULL → a GLOBAL default (the column is nullable). The send
-- step selects the active system-default email template; this is that row.
--
-- Idempotent: no-op if an active-or-inactive system-default email template
-- already exists (templates has no unique index to ON CONFLICT against, so the
-- guard is a NOT EXISTS). Neutral first-past-due dunning copy with {{variables}}
-- for the fill points — edit the wording before live send is ever enabled.
--
-- Brick B mirror: the subject and body below are the EXACT live template row
-- (verified against the live DB), a seven-token, payment-link-bearing copy
-- (client_name, invoice_number, amount_due, invoice_date, due_date,
-- payment_link, subscriber_name). This file is the repo CATCHING UP to the live
-- DB — it is NOT applied (the DB is already this exact row). It only takes
-- effect on a fresh environment where no system-default email template exists.
-- The {{payment_link}} slot is what the send step's payment-link gate requires.

insert into public.templates
  (subscriber_id, name, channel, trigger_event, subject, body, is_active, is_system_default)
select
  null,
  'System default — first past-due email',
  'email',
  'invoice_overdue',
  'Regarding invoice {{invoice_number}} — {{amount_due}} outstanding',
  E'Hi {{client_name}},\n\n'
  || E'Our records show invoice {{invoice_number}} for {{amount_due}}, issued on {{invoice_date}}, '
  || E'is now past its due date of {{due_date}}.\n\n'
  || E'If this has already been taken care of, please disregard this message and accept our thanks. '
  || E'If not, you can settle it here:\n\n'
  || E'{{payment_link}}\n\n'
  || E'If there''s any question about this invoice or you''d like to arrange a different payment '
  || E'schedule, just reply to this email and we''ll sort it out together.\n\n'
  || E'Thank you,\n{{subscriber_name}}',
  true,
  true
where not exists (
  select 1 from public.templates
  where is_system_default = true and channel = 'email'
);

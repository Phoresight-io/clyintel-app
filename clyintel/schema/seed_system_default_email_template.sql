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
-- Brick B mirror: the LIVE row already carries the six-token, payment-link-
-- bearing copy below (client_name, invoice_number, amount_due, invoice_date,
-- due_date, payment_link, subscriber_name). This file is the repo CATCHING UP
-- to the live DB — it is NOT applied (the DB is already correct). It only takes
-- effect on a fresh environment where no system-default email template exists.
-- The {{payment_link}} slot is what the send step's payment-link gate requires.

insert into public.templates
  (subscriber_id, name, channel, trigger_event, subject, body, is_active, is_system_default)
select
  null,
  'System default — first past-due email',
  'email',
  'invoice_overdue',
  'Reminder: invoice {{invoice_number}} is past due',
  E'Hi {{client_name}},\n\n'
  || E'This is a friendly reminder that invoice {{invoice_number}} for {{amount_due}}, '
  || E'issued on {{invoice_date}} and due on {{due_date}}, is now past due.\n\n'
  || E'If you have already sent payment, thank you — please disregard this note. '
  || E'Otherwise, you can pay online here: {{payment_link}}\n\n'
  || E'Thank you,\n{{subscriber_name}}',
  true,
  true
where not exists (
  select 1 from public.templates
  where is_system_default = true and channel = 'email'
);

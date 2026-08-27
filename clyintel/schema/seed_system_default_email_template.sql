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

insert into public.templates
  (subscriber_id, name, channel, trigger_event, subject, body, is_active, is_system_default)
select
  null,
  'System default — first past-due email',
  'email',
  'invoice_overdue',
  'Reminder: invoice {{invoice_number}} is past due',
  E'Hi {{client_name}},\n\n'
  || E'This is a friendly reminder that invoice {{invoice_number}} for {{amount_due}} '
  || E'was due on {{due_date}} and is now past due.\n\n'
  || E'If you have already sent payment, thank you — please disregard this note. '
  || E'Otherwise, we would appreciate it if you could arrange payment at your earliest '
  || E'convenience.\n\n'
  || E'Thank you,\nThe Clyintel team',
  true,
  true
where not exists (
  select 1 from public.templates
  where is_system_default = true and channel = 'email'
);

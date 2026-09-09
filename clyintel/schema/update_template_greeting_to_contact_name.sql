-- Migration: update_template_greeting_to_contact_name
-- Contacts Fix 2b — switch the live system-default email template greeting from
-- the CLIENT (company) token to the CONTACT (person) token.
--
-- The seed (seed_system_default_email_template.sql) only inserts WHERE NOT EXISTS,
-- so it does NOT update the already-present live row — this UPDATE does.
--
-- SEQUENCING (load-bearing): apply this ONLY AFTER the Fix 2b code is live. The
-- code provides {{contact_name}} in RenderVars (sendEmailStep.ts); until the code
-- ships, {{contact_name}} would render as a literal token. The code is harmless
-- before this runs — it sets contact_name but nothing consumes it until this
-- greeting change lands. Order: merge code → apply this migration.
--
-- Idempotent via the LIKE guard: once the greeting is '{{contact_name}}', the
-- WHERE matches nothing, so a re-run is a clean no-op.
--
-- APPLY: Charles applies via Supabase MCP apply_migration
-- (name: update_template_greeting_to_contact_name) AFTER the code merges.
-- Do NOT auto-apply.

update public.templates
set body = replace(body, 'Hi {{client_name}},', 'Hi {{contact_name}},'),
    updated_at = now()
where is_system_default = true
  and is_active = true
  and channel = 'email'
  and body like 'Hi {{client_name}},%';

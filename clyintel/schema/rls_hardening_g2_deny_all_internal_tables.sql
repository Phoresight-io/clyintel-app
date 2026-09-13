-- Migration: rls_hardening_g2_deny_all_internal_tables
-- RLS hardening G2 of G1–G4. Run after G1.
--
-- Adds an explicit default-deny policy to the internal, server-only tables that
-- have RLS enabled but no policy. These are written exclusively by the
-- service_role (which bypasses RLS), so anon/authenticated must never touch them.
-- Mirrors the "Deny all access to anon and authenticated" policy already live on
-- public.demo_sessions (see fix_security_advisor_findings.sql): it records the
-- intent explicitly and clears the "RLS enabled, no policy" advisor lint.

CREATE POLICY "Deny all access to anon and authenticated"
  ON public.ledger_sync
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny all access to anon and authenticated"
  ON public.voice_call_events
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny all access to anon and authenticated"
  ON public.webhook_events
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

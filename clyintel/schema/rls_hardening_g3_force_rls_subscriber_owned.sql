-- Migration: rls_hardening_g3_force_rls_subscriber_owned
-- RLS hardening G3 of G1–G4. Run after G2.
--
-- FORCE ROW LEVEL SECURITY on the 17 subscriber-owned tables so RLS policies
-- apply even to the table OWNER role, not just to anon/authenticated. Without
-- FORCE, a connection as the table-owner/postgres role would bypass every
-- isolation policy.
--
-- Precondition (verified 2026-09-13 against the codebase): the app connects to
-- Postgres ONLY via the Supabase anon key (SSR/browser/middleware) and the
-- service_role key (lib/supabase.ts). There is NO owner-role/postgres/raw-pg
-- connection in app or lib. FORCE RLS does NOT affect service_role (it has
-- BYPASSRLS), so the privileged server paths are unchanged; the only role this
-- would have newly constrained is an owner-role connection, of which there are
-- none. Safe to apply.
--
-- Config/global tables (plans, cadences, cadence_steps, app_config,
-- capture_sources) and audit_log are intentionally NOT forced.

ALTER TABLE public.subscribers              FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clients                  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoices                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.communications           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.voice_calls              FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_attempts        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payments                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.balance_events           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_contacts          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_cadence_progress FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_links           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connected_accounts       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.templates                FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payout_accounts          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.rev_share_ledger         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ptr_scores               FORCE ROW LEVEL SECURITY;

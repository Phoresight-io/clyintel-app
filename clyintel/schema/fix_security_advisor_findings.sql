-- Migration: fix_security_advisor_findings
-- Remediates all Supabase security advisor findings (7 -> 0).

-- 1. Pin search_path on trigger functions (function_search_path_mutable)
ALTER FUNCTION public.set_ptr_score_month() SET search_path = '';
ALTER FUNCTION public.update_updated_at() SET search_path = '';

-- 2. Revoke EXECUTE on SECURITY DEFINER functions from API-exposed roles.
--    These are (event) trigger functions and must never be RPC-callable.
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- 3. demo_sessions has RLS enabled but no policy. It holds PII and is only
--    accessed server-side via the service_role (which bypasses RLS). Add an
--    explicit default-deny policy so the intent is recorded and the lint clears.
CREATE POLICY "Deny all access to anon and authenticated"
  ON public.demo_sessions
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Migration: rls_hardening_g1_drop_demo_policies_communications
-- RLS hardening G1 of G1–G4. Run FIRST.
--
-- Drops two stale demo-era policies on public.communications. Demo mode was
-- retired at D2 close-out; these policies are dead surface area. Removing them
-- leaves the table's real subscriber-isolation policy as the only grant.
-- Idempotent (IF EXISTS) — safe to re-run.

DROP POLICY IF EXISTS allow_demo_reads ON public.communications;
DROP POLICY IF EXISTS allow_demo_inserts ON public.communications;

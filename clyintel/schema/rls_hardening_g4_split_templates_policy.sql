-- Migration: rls_hardening_g4_split_templates_policy
-- RLS hardening G4 of G1–G4. Run after G3.
--
-- Fixes a newly found gap. public.templates currently has a single FOR ALL policy
-- `subscriber_isolation` with USING (subscriber_id = auth.uid() OR subscriber_id
-- IS NULL) and no restrictive write clause. Because a FOR ALL policy applies its
-- USING expression to writes too, this lets ANY authenticated subscriber
-- create / modify / delete GLOBAL (NULL-owner) templates — including the system
-- default the outreach agent sends for every tenant. A single tenant could edit
-- or delete the shared default and affect all subscribers' outreach.
--
-- Split into per-command policies: globals stay READABLE by everyone, but writes
-- are constrained to rows the caller owns (subscriber_id = auth.uid()), so a
-- NULL-owner global template can no longer be written by any subscriber. The
-- service_role continues to manage globals (it bypasses RLS).

DROP POLICY IF EXISTS subscriber_isolation ON public.templates;

CREATE POLICY templates_select ON public.templates
  FOR SELECT
  USING (subscriber_id = auth.uid() OR subscriber_id IS NULL);

CREATE POLICY templates_insert ON public.templates
  FOR INSERT
  WITH CHECK (subscriber_id = auth.uid());

CREATE POLICY templates_update ON public.templates
  FOR UPDATE
  USING (subscriber_id = auth.uid())
  WITH CHECK (subscriber_id = auth.uid());

CREATE POLICY templates_delete ON public.templates
  FOR DELETE
  USING (subscriber_id = auth.uid());

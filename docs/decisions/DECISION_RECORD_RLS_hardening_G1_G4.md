# Decision Record: RLS Hardening G1–G4

**Status:** AUTHORED — migrations written, **NOT YET APPLIED**. Apply to Prod via
the Supabase MCP after review.
**Date:** 2026-09-13
**Scope:** Policy/RLS-flag changes only — zero table/column shape change, no type
regeneration, no engine/live-send changes.
**Files:** `clyintel/schema/rls_hardening_g1..g4_*.sql` (run in order G1 → G4).

---

## Why

A pass over the live Supabase RLS configuration (verified 2026-09-13) surfaced
four gaps between the intended tenant-isolation posture and what the policies
actually enforce. Each migration is single-purpose and independently reviewable.

## G1 — drop stale demo policies on `communications`

Demo mode was retired at D2 close-out, but two demo-era policies
(`allow_demo_reads`, `allow_demo_inserts`) still exist on `public.communications`.
Dead grant surface — dropped. Idempotent (`IF EXISTS`).

## G2 — explicit deny-all on internal tables

`ledger_sync`, `voice_call_events`, and `webhook_events` have RLS enabled but no
policy. They are written only by the `service_role` (which bypasses RLS), so
anon/authenticated must never reach them. Adds the same explicit
"Deny all access to anon and authenticated" policy already live on
`demo_sessions` (see `fix_security_advisor_findings.sql`) — records intent and
clears the "RLS enabled, no policy" advisor lint.

## G3 — FORCE RLS on the subscriber-owned set (17 tables)

Enabling RLS is not enough: the table **owner** role bypasses policies unless
`FORCE ROW LEVEL SECURITY` is set. Forced on the 17 subscriber-owned tables.
Config/global tables (`plans`, `cadences`, `cadence_steps`, `app_config`,
`capture_sources`) and `audit_log` are intentionally excluded.

**Precondition (verified in code, 2026-09-13):** the app connects to Postgres
ONLY via the Supabase anon key (`lib/supabase-server.ts`, `lib/supabase-browser.ts`,
`middleware.ts`, `app/auth/callback/route.ts`) and the service_role key
(`lib/supabase.ts`). There is **no** owner-role / `postgres` / raw-`pg` /
`DATABASE_URL` connection in `app` or `lib`. `FORCE RLS` does not affect
service_role (it has `BYPASSRLS`), so the privileged server paths are unchanged;
the only role this newly constrains is an owner-role connection, of which there
are none. **Finding: precondition holds — G3 is safe to apply.**

## G4 — split the `templates` policy (newly found gap)

`public.templates` had a single `FOR ALL` policy `subscriber_isolation` with
`USING (subscriber_id = auth.uid() OR subscriber_id IS NULL)` and **no restrictive
write clause**. A `FOR ALL` policy applies its `USING` expression to writes as
well as reads, so this permitted **any authenticated subscriber to INSERT / UPDATE
/ DELETE global (NULL-owner) templates — including the system-default email
template the outreach agent sends for every tenant.** One tenant could alter or
delete the shared default and break outreach for all subscribers.

**Decision:** replace the single policy with per-command policies so globals stay
readable by everyone but writable only by service_role:
- `templates_select` — `USING (subscriber_id = auth.uid() OR subscriber_id IS NULL)` (unchanged read scope: own + global).
- `templates_insert` — `WITH CHECK (subscriber_id = auth.uid())`.
- `templates_update` — `USING` + `WITH CHECK (subscriber_id = auth.uid())`.
- `templates_delete` — `USING (subscriber_id = auth.uid())`.

A NULL-owner (global) row now matches no write policy for anon/authenticated, so
only the service_role (bypass) can manage globals. Own-template reads/writes are
unchanged.

---

## Application

These are **not applied** by this PR. After review, apply G1 → G2 → G3 → G4 in
order via the Supabase MCP against Prod. No cron, no `vercel.json`, no type
regeneration is involved.

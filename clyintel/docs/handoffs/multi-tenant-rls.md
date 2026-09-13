# Handoff — Multi-Tenant RLS Hardening & Agent Isolation Verification

_Workstream: Email Agent (Agent 1 Outreach) — "one agent can service all subscribers" foundation_
_Author: Claude (chat + MCP, grounding/spec role). Builder: Claude Code (CC). Merger: Charles._
_Grounded against `main` and live Supabase `mhvuqjryesjsrictesuk` on 2026-09-13._
_Status: COMPLETED 2026-09-13 — this is the closed-brick record._

---

## 1. Goal

Make it provably safe for a single automated agent (service-role) to service **all** subscribers at once:

1. **Close the RLS gaps** so the user-facing (anon / authenticated) surface is fully tenant-isolated on every table.
2. **Prove the agent's service-role code path** stamps every write with the correct `subscriber_id` — zero cross-tenant bleed on an unfenced, all-subscriber run.

This establishes the isolation guarantees the later **synchronous reply-handling** and **HITL handoff** bricks build on. It does **not** turn automation on (gated separately — see §6).

---

## 2. Outcome summary (as-built)

All four RLS gaps (G1–G4) were applied to Prod via `apply_migration` (`rls_hardening_g1..g4`, recorded in the `supabase_migrations` ledger) and behaviorally verified against live data. Both isolation surfaces are proven:
- **User surface (RLS):** tenant-isolation proven live by role impersonation (a non-owner reads 0 of the owner's rows across all subscriber-owned tables; write-forge rejected) and codified in `tenant-isolation.test.ts`.
- **Agent surface (code):** the port-driven cadence engine run unfenced over a >=2-subscriber in-memory fixture stamps every write with its invoice's own `subscriber_id`; proven green in `agent-isolation.test.ts`.

PRs: #108 (tenant-isolation test), #109 (G1–G4 migration files + decision record), #110 (agent-isolation test) — all merged. Migrations were applied to Prod via MCP as a step separate from the merges.

---

## 3. Gaps (final)

| # | Finding | Fix | Status |
|---|---------|-----|--------|
| G1 | Stale demo policies on `communications` (`allow_demo_reads`, `allow_demo_inserts`, anon, keyed on `airtable_subscriber_id='demo'`; demo mode flushed). | Drop both. | Done — `communications` now has exactly one policy (`subscriber_isolation`). Verified. |
| G2 | `ledger_sync`, `voice_call_events`, `webhook_events` RLS-on but 0 policies (implicit deny-all). | Explicit `Deny all access to anon and authenticated` (`FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)`), mirroring `demo_sessions`. | Done. Verified. |
| G3 | `FORCE ROW LEVEL SECURITY` off everywhere. | `FORCE ROW LEVEL SECURITY` on the 17 subscriber-owned tables (config/global + `audit_log` excluded). | Done. Precondition verified: app connects only as anon + service-role, no owner-role connection. |
| G4 | **(New, found via live write-side probe)** `templates` policy `FOR ALL USING (subscriber_id = auth.uid() OR subscriber_id IS NULL)` had no restrictive `WITH CHECK`, so any authenticated subscriber could INSERT/UPDATE/DELETE global (`NULL`-owner) templates — including the system default the agent sends for all tenants (see S2). Read isolation was fine; the gap was write-side. | Split per-command: `SELECT` keeps `own + NULL` (global read preserved); `INSERT`/`UPDATE`/`DELETE` own rows only. | Done. Re-probed: global-template INSERT blocked (`42501`), UPDATE touches 0 rows, global read still works, cross-tenant reads still 0. |
| S1 | Shared sender — `sendEmailStep` hardcodes `FROM_ADDRESS = "team@phoresight.io"`. | Named seam (per-subscriber verified sending domain later). | Open seam, by design, out of scope. |
| S2 | Global template — `loadActiveSystemDefaultEmailTemplate()` loads the global system-default. | Named seam. | Open seam. Write access to globals now locked down by G4; the shared-default design itself remains. |

---

## 4. As-built artifacts

- `clyintel/schema/rls_hardening_g1_drop_demo_policies_communications.sql`
- `clyintel/schema/rls_hardening_g2_deny_all_internal_tables.sql`
- `clyintel/schema/rls_hardening_g3_force_rls_subscriber_owned.sql`
- `clyintel/schema/rls_hardening_g4_split_templates_policy.sql`
- `docs/decisions/DECISION_RECORD_RLS_hardening_G1_G4.md`
- `clyintel/tests/tenant-isolation.test.ts` (skip-gated on `SUPABASE_DB_URL`; run it once against a real DB to self-validate its 17-table seeding)
- `clyintel/lib/outreach/agent-isolation.test.ts` (in-memory, green in CI)

Migrations live in `clyintel/schema/` (no CLI runner — applied via `apply_migration`). Tests are co-located `*.test.ts` (Vitest).

---

## 5. Notes for the next brick

- **Engine is fully port-driven:** `runCadence(now, port)`, `sendEmailStep(ctx, mode, port)`. Stamping comes only from each invoice's own `subscriber_id`; the run-level `subscriberId` is a candidate-scan fence, never a stamp source.
- **Prod test data is QBO-test-account sync** — one subscriber carries invoices (`test_user=true`), and Prod invoice state moves on its own via the live QBO webhook. `test_user` is therefore NOT a safe teardown discriminator.

---

## 6. The real gate (not solved here)

Turning the agent on automatically across all subscribers is blocked by **Preview/Prod Supabase separation**, not by RLS. Today a single shared Supabase project backs both environments, so any registered cron writes the live DB on every tick. That is why no `vercel.json` cron exists and the outreach engine is manual-invoke-only.

Decision (2026-09-13): the current project (`mhvuqjryesjsrictesuk`) remains **Prod**; **Test** will be a copy — a new Supabase project seeded by replaying the migration ledger. (Not being created yet.) Once Test exists and the cron points only at Prod, the automation gate opens.

---

## 7. Sequencing

RLS hardening + isolation proof (**this brick — COMPLETE**) → Preview/Prod Supabase separation, i.e. stand up the Test copy (gate, deferred) → synchronous reply-handling → HITL handoff. Client Score is a parallel track feeding the (deferred) Agent 2 Strategist.

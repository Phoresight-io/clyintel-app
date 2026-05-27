# FEEDBACK_LOOP.md — clyintel
_Lessons, retros, and delivery notes. Append — never overwrite._
_Started: 2026-05-16_

---

## Entry 001 — 2026-05-16
**Phase:** Sync — Setup file corrections
**Scope:** Open D3 framework scaffolding + no-code to code-first transition

### What was completed
- Root `CLAUDE.md` created with stack, commands, agent rules, and Open D3 pipeline entry points
- `clyintel/CLAUDE.md` created with product config, Airtable schema stubs, and known constraints
- `clyintel/schema/README.md` and `clyintel/types/README.md` created as placeholders
- `.ai/CONSTITUTION.md`, `.ai/SOURCES.md`, `.ai/clyintel/PRODUCT_CONTEXT.md` created with full product spec
- `.ai/clyintel/CODE_CONTEXT.md` and `.ai/clyintel/FEEDBACK_LOOP.md` created as placeholders
- All four files corrected per `clyintel-setup-vs-gap.md` gap analysis

### Root cause of corrections needed
Initial setup files were drafted against the old no-code stack (Airtable as operational DB, Make as automation layer). The gap analysis identified that the product had already transitioned to a code-first architecture before the Open D3 files were committed. The files went into the repo reflecting the retired stack rather than the current one.

### What the transition means
| Before | After |
|---|---|
| Airtable = operational database | Supabase (Postgres) = operational database |
| Make scenarios = automation layer | Supabase Edge Functions = automation layer |
| Airtable Single Select + typecast workarounds | Postgres enum types — enforced at schema level |
| Airtable linkedRecord for plan FK | `subscriber.plan_id` FK → `plans.id` in Postgres |
| Airtable rollup fields | SQL aggregates / materialized views |

### Outcome
All Open D3 files now reflect the code-first stack. Airtable IDs preserved in `PRODUCT_CONTEXT.md` as migration reference only. Make archived in `SOURCES.md`. No retired patterns referenced in active rules or conventions.

### Open items carried forward
See `PRODUCT_CONTEXT.md` → Open Items for the full P1/P2 list. Top priorities:
- Supabase: apply initial schema migration
- Anthropic API key
- Twilio account setup
- Vercel: connect repo

<!-- Append new entries below this line. Never edit entries above. -->

---

## Entry 006 — 2026-05-18
**Phase:** Build — UI prototype complete + polish
**Scope:** ConnectionsScreen, Settings/Integrations, polish pass, branch merged to main

### What was completed
- Ported `ConnectionsScreen` from `clyintel_after.jsx` into Next.js App Router
  - New route: `/connections` (`app/connections/page.tsx`)
  - Stages: connect → connecting → select client → analyzing → back to `/`
  - Manual Entry sub-flow: form → saved confirmation → back to `/`
  - Deep-link: `/connections?mode=manual` jumps directly to manual form
- Added Settings / Integrations screen (`/settings`)
  - Connected integration cards with Sync Now / Disconnect actions
  - Available integrations grid
  - Manual entry banner → routes to `/connections?mode=manual`
- PTRWidget: per-client recommendations wired to `ptrRecommendations` in mock-data
- Polish pass: per-client score rail copy, real `prevScore` deltas, dynamic footer date, dashboard empty-table state, Total Outstanding shows "—" at $0
- Branch `claude/build-ui-prototype-tSQ7P` merged to `main` and promoted to production

### Build result
Clean TypeScript pass. 6 routes: `/`, `/client/[id]`, `/connections`, `/portfolio`, `/settings`, `/_not-found`

### Open items carried forward
- Remaining P1 items from Entry 005 unchanged (Twilio, MailerSend, QBO OAuth)

---

## Entry 005 — 2026-05-18
**Phase:** Sync — P1 item sweep
**Scope:** Supabase types, Stripe archive, env vars, domain investigation

### What was completed
- Supabase: confirmed schema already fully built (16 migrations, 12 tables, plans seeded)
- Generated `clyintel/types/supabase.ts` from live `clyintel-dev` project
- Wired up `@supabase/supabase-js` client (`lib/supabase.ts`) — typed, mock data untouched
- Anthropic API key: set in Vercel as `Anthrop_API_Key`
- ST-01: Archived both legacy AR Hunter Stripe products (`prod_TQM8ODk7fiW82r`, `prod_TPCn2lRuTLTMF4`) — confirmed `active: false`
- GH-01: Diagnosed — GitHub App has All Repositories access. Session scope is a Claude Code platform limitation (one repo per session). No fix available.
- Vercel `clyintel-app.vercel.app` 404: Root cause identified — production branch still set to `claude/setup-open-d3-framework-fAvPt`. Vercel API PATCH attempts failed. Carrying forward.

### Working URL
https://clyintel-app-git-main-phoresight-ios-projects.vercel.app

### Open items carried forward
- Vercel: find and update Production Branch setting to `main` so `clyintel-app.vercel.app` resolves
- Twilio: account setup + phone number
- MailerSend: inbound routing
- QBO OAuth: register app

---

## Entry 004 — 2026-05-18
**Phase:** Sync — Vercel root directory fix
**Scope:** 404 resolution, demo app live

### What was completed
- Root Directory set to `clyintel` in Vercel project settings → deployment rebuilt green
- Demo app confirmed live at https://clyintel-app.vercel.app

### Root cause of 404
Vercel was deploying from repo root, not the `clyintel/` subdirectory. Next.js app lives in `clyintel/`, so Vercel found no `package.json` at root and served a 404.

### Lesson
For monorepo layouts, Vercel Root Directory must be set before or immediately after the first deployment — not after the first 404. Add this step to the Vercel connection checklist.

### Current state
Demo is fully live. All three routes functional: `/` (Dashboard), `/portfolio` (Client List), `/client/[id]` (Detail).

### Open items carried forward
- Supabase: apply initial schema migration
- Anthropic API key
- Twilio: account setup + phone number
- MailerSend: inbound routing
- QBO OAuth: register app
- ST-01: Archive legacy AR Hunter Stripe products
- GH-01: Fix GitHub MCP connector scope

---

## Entry 002 — 2026-05-17
**Phase:** Sync — Open D3 alignment check
**Scope:** Cross-file consistency pass across all repo docs

### What was found
`clyintel/CLAUDE.md` was not updated during the Entry 001 gap analysis pass. It contained three alignment failures:

| Field | Stale value | Correct value |
|---|---|---|
| Product description | "intelligence briefing tool for sales teams" | AR/collections intelligence platform |
| Airtable Schema section | Listed as "source of truth for CRM/ops data" with Companies/Contacts/Briefings tables | Retired. Supabase is the operational DB. |
| AI provider | "To be confirmed" | Anthropic API — `claude-sonnet-4-6` |
| Agent Rule 1 | "Always check Airtable schema before writing Airtable integration code" | Replaced — no new Airtable code; Supabase is the DB |

All other files (root `CLAUDE.md`, `CONSTITUTION.md`, `SOURCES.md`, `PRODUCT_CONTEXT.md`, `CODE_CONTEXT.md`) were confirmed aligned.

### What was fixed
- `clyintel/CLAUDE.md` rewritten to reflect correct product description, stack, key decisions, and agent rules.

### Lesson
The gap analysis pass (Entry 001) targeted `.ai/` files only. `clyintel/CLAUDE.md` was in a different folder and was missed. Future sync passes must include all `CLAUDE.md` files in the repo, not just `.ai/`.

---

## Entry 003 — 2026-05-18
**Phase:** Sync — Demo deployment
**Scope:** Vercel deployment of clyintel demo app

### What was completed
- Vercel project imported and connected to `phoresight-io/clyintel-app` repo
- Demo app deployed and live at https://clyintel-app.vercel.app
- Root directory set to `clyintel/` in Vercel project settings

### What was updated
- `PRODUCT_CONTEXT.md`: Vercel P1 open item marked ✅
- `CODE_CONTEXT.md`: Repo structure updated to reflect full Next.js scaffold, Vercel URL recorded, architectural state updated
- `SOURCES.md`: Vercel entry to be confirmed live (project ref now known)

### Open items carried forward
Remaining P1 items:
- Supabase: apply initial schema migration
- Anthropic API key
- Twilio: account setup + phone number
- MailerSend: inbound routing
- QBO OAuth: register app
- ST-01: Archive legacy AR Hunter Stripe products
- GH-01: Fix GitHub MCP connector scope

---

## Entry 007 — 2026-05-27
**Phase:** Sync — stack documentation + schema cleanup
**Scope:** SOURCES.md updated, CODE_CONTEXT.md updated, TEST_SPEC.md created, billing_path enum cleaned

### What was completed
- SOURCES.md: Vapi confirmed, PAYG removed from launch, Make/Airtable/Softr fully retired, Google OAuth confirmed
- CODE_CONTEXT.md: Full current state including what exists, what doesn't, all Beta blockers in priority order
- TEST_SPEC.md: 3-category test plan — schema integrity, RLS enforcement (critical), subscriber Beta flows
- Supabase migration: removed `payg` from `billing_path` enum — Revenue Share only at launch

### PAYG status
Removed from launch. Roadmap item. Do not re-add without a product decision from Charles.

### Open items carried forward
See CODE_CONTEXT.md → "What does not exist yet" — 12 Beta blockers in priority order. Auth + RLS policies are the first session.

---

## Entry 008 — 2026-05-27
**Phase:** Build — Auth + RLS + Audit Log
**Scope:** Session 1 of Beta blockers

### What was completed

**Supabase Auth (Beta blocker #1)**
- Installed `@supabase/ssr@0.10.3`
- Created `lib/supabase-server.ts` — server-side client using `createServerClient`, reads cookies from `next/headers`
- Created `lib/supabase-browser.ts` — browser client using `createBrowserClient`
- Created `app/auth/callback/route.ts` — exchanges OAuth code for session, redirects to `/` on success or `/login` on error
- Deleted `app/api/auth/google/callback/route.ts` — old implicit-grant handler, replaced by Supabase Auth PKCE flow
- Created `app/login/page.tsx` — email/password sign in + sign up + Google OAuth button, styled with C tokens, no external UI libraries
- Updated `AppShell.tsx` — bypass shell chrome when `pathname === '/login'` or starts with `/auth/`

**Auth middleware (Beta blocker #2)**
- Created `middleware.ts` — refreshes session on every request, redirects unauthenticated users to `/login`, redirects authenticated users away from `/login`. Public paths: `/login`, `/auth/callback`, `/api/stripe-webhook`

**Subscriber record on signup (Beta blocker #6)**
- Applied migration `create_subscriber_on_signup` — Postgres function + trigger on `auth.users INSERT`
- Inserts subscriber row with: `id = auth.uid()`, `email`, `plan_id` = Free tier, `billing_path = 'revenue_share'`, `subscription_status = 'trialing'`, `business_name = ''`
- `ON CONFLICT (id) DO NOTHING` guards against duplicate inserts
- Fires for both email/password signups and Google OAuth new users

**Audit log table (Beta blocker #4)**
- Applied migration `create_audit_log` — creates `audit_log` table with required columns
- RLS enabled: subscribers can read own rows (SELECT policy), no INSERT policy = service role only
- Columns: `id, subscriber_id, actor, actor_detail, action, entity_type, entity_id, payload, created_at`

**RLS policies (Beta blocker #3)**
- Applied migration `rls_policies_all_tables` — `subscriber_isolation` policy on all 10 subscriber-scoped tables
- `invoice_payments` scoped via join to `invoices`
- `templates` allows own rows OR `subscriber_id IS NULL` (system defaults)
- `plans` read-only for all authenticated users, no write policies
- `demo_sessions` — intentionally no policies (service role only)

**Schema cleanup (Beta blocker #5)**
- Applied migration `remove_payg_billing_path` in previous session ✅

### Migration names applied
1. `remove_payg_billing_path` (previous session)
2. `create_audit_log`
3. `rls_policies_all_tables`
4. `create_subscriber_on_signup`

### Policy verification
All 12 subscriber-facing tables have at least one RLS policy. `demo_sessions` and `audit_log` (INSERT) are service-role-only by design. `communications` retains two pre-existing demo policies alongside the new `subscriber_isolation` policy — demo AI agents still function.

### What does not exist yet (remaining Beta blockers)
| # | Item | Notes |
|---|---|---|
| 7 | Stripe Checkout → webhook → subscriber plan update | Next session priority |
| 8 | Replace mock data with real Supabase queries | Requires auth session context wired into components |
| 9 | AI agent subscriber scoping | Replace `'demo'` hardcode in email/SMS/voice agents |
| 10 | Twilio account + phone number | External setup required |
| 11 | MailerSend inbound routing | External config required |
| 12 | Stripe webhook re-pointed from Make to Next.js | `STRIPE_WEBHOOK_SECRET` env var pending |

### Open items requiring decisions or follow-up
1. **Google OAuth — manual Supabase config required:** The Supabase MCP does not expose Auth provider settings. Enable Google provider in Supabase dashboard → Authentication → Providers → Google. Add redirect URLs: `https://clyintel-app-git-main-phoresight-ios-projects.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`. Add `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Vercel env vars.
2. **Import page Drive picker broken:** `app/import/page.tsx` references the now-deleted `/api/auth/google/callback` for Drive OAuth (separate from auth). The import CSV-from-Drive flow will not work until this is re-implemented. Not a Beta blocker — import page is demo-only.
3. **Email confirmation flow:** Supabase email confirmation is enabled by default. New email signups will receive a confirmation email before they can log in. Decision needed: disable email confirmation for Beta, or keep and handle the "check your email" UX (currently handled — login page shows the message).
4. **`NEXT_PUBLIC_GOOGLE_CLIENT_ID` env var:** Required for Google OAuth to work. Must be added to Vercel project settings before Google sign-in is functional.

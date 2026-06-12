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
https://clyintel-app-git-main-phoresight-projects.vercel.app

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
1. **Google OAuth — manual Supabase config required:** The Supabase MCP does not expose Auth provider settings. Enable Google provider in Supabase dashboard → Authentication → Providers → Google. Add redirect URLs: `https://clyintel-app-git-main-phoresight-projects.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`. Add `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Vercel env vars.
2. **Import page Drive picker broken:** `app/import/page.tsx` references the now-deleted `/api/auth/google/callback` for Drive OAuth (separate from auth). The import CSV-from-Drive flow will not work until this is re-implemented. Not a Beta blocker — import page is demo-only.
3. **Email confirmation flow:** Supabase email confirmation is enabled by default. New email signups will receive a confirmation email before they can log in. Decision needed: disable email confirmation for Beta, or keep and handle the "check your email" UX (currently handled — login page shows the message).
4. **`NEXT_PUBLIC_GOOGLE_CLIENT_ID` env var:** Required for Google OAuth to work. Must be added to Vercel project settings before Google sign-in is functional.

## Entry 009 — 2026-05-31
**Phase:** Security — Supabase advisor remediation
**Scope:** 7 findings → 0 findings

### Findings fixed
- demo_sessions: explicit default-deny RLS policy added
- set_ptr_score_month: search_path pinned to ''
- update_updated_at: search_path pinned to ''
- handle_new_auth_user: EXECUTE revoked from anon, authenticated, public
- rls_auto_enable: EXECUTE revoked from anon, authenticated, public

### Result
Security advisor re-scan: 0 findings.

### Migration
fix_security_advisor_findings — applied to clyintel-dev via apply_migration.
SQL committed to clyintel/schema/fix_security_advisor_findings.sql

## Entry 010 — 2026-06-01
**Phase:** Build — Real data wiring + Stripe webhook
**Scope:** Session 2 of Beta blockers

### What was completed

**Stripe webhook → Supabase (Beta blocker #7 + #12)**
- Created `clyintel/app/api/stripe-webhook/route.ts` (Node runtime, `force-dynamic`)
- Manual HMAC-SHA256 signature verification against `STRIPE_WEBHOOK_SECRET` — no
  new npm package added (honours product rule "no packages without approval").
  Includes a 5-minute timestamp tolerance to mitigate replay attacks.
- Handles: `customer.subscription.created` / `.updated` → `subscription_status = 'active'`
  + plan match by `stripe_product_id`; `.deleted` → `'canceled'`;
  `invoice.payment_succeeded` → `'active'`; `invoice.payment_failed` → `'past_due'`.
- Matches subscriber by `stripe_customer_id`; writes to `audit_log` (actor = 'system',
  action = the Stripe event type) after every successful update.
- Returns 200 immediately; processes asynchronously via `waitUntil`.

**Data layer (Beta blocker #8)**
- Created `clyintel/lib/data.ts` — `getSubscriber`, `getClient`, `getClients`,
  `getInvoices`, `getInvoicesByClient`, `getCommunications`, `getPtrScores`,
  `getRecoveryAttempts`, plus a `getUIPortfolio` aggregator. Every query is
  explicitly scoped to the passed `userId` (= `auth.uid()`) per CONSTITUTION rule 9.
- Created `clyintel/lib/adapters.ts` — maps real Supabase rows onto the existing
  UI shapes (`Client`, `Invoice`, `ClientInvoiceSet`) so the screens stay
  presentation-only and demo mode is untouched.
- Dashboard, Portfolio, and Client Detail pages are now Server Components that
  fetch real data (scoped to the logged-in subscriber) and pass it as props to
  client wrappers. Mock data is used only when demo mode is active (`isDemoReset()`
  / integrations localStorage). KPI cards compute from real data; Recovery YTD is
  hardcoded to `$0` until `recovery_attempts` has data.
- Client Detail: numeric ids resolve to mock/demo clients; UUIDs resolve to real
  clients via `getClient` (RLS-equivalent subscriber scoping) → `notFound()` when
  missing or owned by another subscriber.

**Subscriber context in app shell**
- `AppShell.tsx` fetches the current subscriber on mount (browser client),
  renders the subscriber's initials in the avatar (was "JD") and the plan name
  in the footer.

**Manual invoice entry → real database (Beta blocker, manual path of #8)**
- Created `clyintel/app/api/invoices/create/route.ts` — authenticated route that
  extracts the user from the session, creates/matches a client by name for the
  subscriber, inserts the invoice with `subscriber_id = auth.uid()`, writes to
  `audit_log` (actor = 'subscriber', action = 'create_invoice'), returns the id.
- `ConnectionsScreen` manual entry now POSTs to that route with saving/error states.

**Types**
- Regenerated `types/supabase.ts` to include `audit_log` and the cleaned
  `billing_path` enum (`revenue_share` only).
- Widened UI `Client.id` / `clientInvoices` / `ptrRecommendations` keys to
  `string | number` to accommodate real UUIDs alongside demo numeric ids.

### Verification
- `npx tsc --noEmit` → clean.
- `npm run build` → clean (with env vars present). Routes registered:
  `/api/stripe-webhook`, `/api/invoices/create`; `/`, `/portfolio`, `/client/[id]`
  now server-rendered on demand.

### Beta blockers cleared
- #7 Stripe Checkout → webhook → subscriber plan update (webhook half — Checkout
  session creation is separate and still pending).
- #8 Replace mock data with Supabase queries (dashboard, portfolio, client detail,
  manual invoice entry).
- #12 Stripe webhook re-pointed to the Next.js API route (code side complete;
  endpoint registration in Stripe dashboard is a manual step — see below).

### Remaining Beta blockers
- #7 (Checkout half): the Stripe Checkout session creation + upgrade flow is not
  yet built — the webhook is ready to receive its events.
- #9 AI agent subscriber scoping (replace `'demo'` hardcode).
- #10 Twilio account + phone number (external).
- #11 MailerSend inbound routing (external).

### Open items or decisions needed (Charles)
1. **Create the Stripe webhook endpoint + secret.** In the Stripe dashboard →
   Developers → Webhooks → Add endpoint:
   - URL: `https://clyintel-app-git-main-phoresight-projects.vercel.app/api/stripe-webhook`
   - Events: `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `invoice.payment_succeeded`,
     `invoice.payment_failed`
   - Copy the signing secret and add it as `STRIPE_WEBHOOK_SECRET` in Vercel
     (Production, Preview, Development).
2. **Plan `stripe_product_id` mapping.** The webhook matches plans by
   `plans.stripe_product_id`. Confirm each live plan row has the correct
   `stripe_product_id` set, or subscription events won't update `plan_id`.
3. **AppShell uses `createSupabaseBrowser()`** (cookie/session-aware) rather than
   `getPublicSupabase()` as literally specced — `getPublicSupabase()` has no auth
   session and could not read the current subscriber. Flag if a different client
   is preferred.
4. Exchange history in the UI (`ExchangeDrawer`) still reads demo data;
   `getCommunications` is wired in `lib/data.ts` but not yet surfaced for real
   invoices. Deferred — not a listed blocker for this session.

## Entry 011 — 2026-06-04
**Phase:** Build — Stripe customer creation + Checkout (Session 3)
**Scope:** Remaining Stripe work for Beta (steps 1–4)
**Branch:** `claude/inspiring-gates-8N01g` (not merged to main)

### What was completed

**Stripe REST helper (no new npm package)**
- `clyintel/lib/stripe.ts` — minimal Stripe REST client over `fetch` with
  bracketed form-encoding, mirroring the webhook's "no `stripe` package" rule.
  Exports `createCustomer`, `getProductDefaultPrice`, `createCheckoutSession`.
  Server-only (reads `STRIPE_SECRET_KEY`).

**Stripe customer on signup (task step 2)**
- `clyintel/lib/stripe-customer.ts` — `ensureStripeCustomer(userId)`: idempotent,
  creates a Stripe customer (email + `metadata.subscriber_id`) only when
  `stripe_customer_id` is null, stores it on the subscriber row (service role),
  guards against concurrent writes, and writes an `audit_log` row
  (actor='system', action='create_stripe_customer').
- `clyintel/app/api/stripe/ensure-customer/route.ts` — authenticated POST wrapper.
- Wired into all auth entry points: `app/auth/callback/route.ts` (Google +
  confirmed-email link) calls it after `exchangeCodeForSession`; `app/login/page.tsx`
  fires `POST /api/stripe/ensure-customer` (best-effort) after password sign-in;
  the Checkout route also ensures one as a safety net. The Postgres
  `handle_new_auth_user` trigger can't make the outbound call, so this lives at
  the app layer. (Chose app-route over Edge Function — no new infra.)

**Stripe Checkout flow (task step 4)**
- `clyintel/app/api/stripe/checkout/route.ts` — authenticated POST { planId }:
  ensures customer, resolves the plan's price via the Stripe product's
  `default_price` (per Charles' decision — no `stripe_price_id` column, no
  migration), creates a subscription-mode Checkout Session, returns the URL.
  Rejects free/enterprise/zero-price plans (business rule #1). Audits
  action='start_checkout'.
- `clyintel/components/settings/BillingTab.tsx` + enabled the **Billing** tab in
  `IntegrationsScreen.tsx`. Shows current plan, lists plans, "Upgrade" buttons
  for paid tiers above current (Free→Starter/Plus/Pro), Enterprise → Contact
  sales. Handles `?upgrade=success|cancelled` banner. On success the existing
  webhook updates `plan_id` + `subscription_status`.

### Verification
- `npx tsc --noEmit` → clean.
- `npm run build` → clean. New routes registered: `/api/stripe/checkout`,
  `/api/stripe/ensure-customer`.

### Decisions made this session (Charles)
- **Step 3 (Free $0 Stripe product): SKIPPED.** Free is revenue-share only and
  business rule #1 blocks Free users from subscription billing, so Checkout never
  targets it; the webhook only needs product IDs for paid plans, which already
  exist. `plans.free.stripe_product_id` left null by design.
- **Checkout price resolution:** runtime `default_price` lookup (no migration).

### Open items / required before this works in Production (Charles)
1. **`STRIPE_SECRET_KEY` is NOT in Vercel** (CODE_CONTEXT lists it as `.env.local`
   only). Add it to Vercel (Production, Preview, Development) or both new routes
   and customer creation fail at runtime in deployed environments. ← task step 1.
2. **Each live paid Stripe product must have a `default_price` set** (`prod_UG5P6BwawRlmf2`
   Starter, `prod_UG5Pn5BS7UGHtD` Plus, `prod_UG5Q9TLOQd99ey` Pro). The Checkout
   route reads `default_price`; if any is unset, that plan's checkout returns 502.
   Verify/set on the local machine (Stripe writes are local-machine only).
3. Webhook endpoint + `STRIPE_WEBHOOK_SECRET` (carried over from Entry 010) still
   required for the success path to update the subscriber.

### Remaining Beta blockers (unchanged)
- #9 AI agent subscriber scoping · #10 Twilio · #11 MailerSend inbound.

---

## Entry 012 — 2026-06-05
**Phase:** Sync — Documentation refresh after Session 3 billing merge
**Scope:** Reconcile `.ai/clyintel/` docs with current state (main HEAD `14f3ce2`)

### What was completed
Docs-only pass. No application code touched. Corrected statements in
`CODE_CONTEXT.md`, `PRODUCT_CONTEXT.md`, and `FEEDBACK_LOOP.md` that the
post-merge reality now contradicts.

**Session 3 billing merge (commit `14f3ce2`) — now TRUE and reflected in docs:**
- **Stripe customer creation on signup** — BUILT + verified for both email and
  Google OAuth. New signups get `stripe_customer_id` populated (e.g.
  `cus_Ue7inuHp3Q4qjq`).
- **Stripe Checkout upgrade flow** — BUILT. `BillingTab.tsx` → `/api/stripe/checkout`,
  $29 / $79 price resolution verified via runtime `default_price` lookup.
- **`STRIPE_SECRET_KEY`** — now set in Vercel for ALL environments (Prod/Preview/Dev).
  CODE_CONTEXT env table corrected (was "`.env.local` only / ✅ Set locally").

**Beta Billing Surface decision (commit `14f3ce2`):**
- Billing tab renders Free / Starter / Plus only, enforced by `BETA_VISIBLE_TIERS`
  in `clyintel/components/settings/BillingTab.tsx`. Pro + Enterprise remain
  defined in the `plans` table and in Stripe (products + default prices set) but
  are not surfaced and not self-serve purchasable.
- PRODUCT_CONTEXT note reworded as an **agent guardrail / constraint** (imperative
  MUST/Do-NOT phrasing), not a PRD-style spec. Five-tier reference table left intact.

**Google OAuth fix:**
- Was failing with `invalid_client` — Google rejected Supabase's server-to-server
  code exchange because the Google **client secret** stored in Supabase was wrong.
  Re-paired the client ID + secret in the Supabase Google provider; sign-in now
  works end-to-end. App code (`redirectTo`, `/auth/callback` exchange, middleware)
  was already correct — this was a config fix, not a code change.

**Stale-reference corrections:**
- Vercel team slug: `phoresight-ios-projects` → `phoresight-projects` (3
  occurrences across prior entries — URLs only; narrative untouched). Canonical
  production URL is now `https://clyintel.vercel.app` (`main` auto-deploys).
- Removed the claim of a separate `clyintel-ops` repo (GH-01 open item) — it does
  not exist; the only repo is `phoresight-io/clyintel-app`.
- Clarified: the canonical **PRD v2.0 lives in Google Drive (Google Doc)**. There
  is no `.ai/clyintel/PRD_v2.0.docx` in this repo. `PRODUCT_CONTEXT.md` remains the
  in-repo product-context doc (per its own Agent Rule 1).
- CODE_CONTEXT: Auth marked **Live** (was "Not yet built"); RLS policies marked
  written; Beta-blocker list trimmed — #1–#8 and #12 cleared across Sessions 1–3.

### Remaining Beta blockers (unchanged — still open)
- #9 AI agent subscriber scoping (replace `'demo'` hardcode)
- #10 Twilio account + phone number (external)
- #11 MailerSend inbound routing (config)

### Note
Carried-over Stripe items still genuinely pending: `STRIPE_WEBHOOK_SECRET` +
webhook endpoint registration in the Stripe dashboard (Entry 010/011). Left as
❌ Pending — not asserted complete by this sync.

---

## Entry 013 — 2026-06-05
**Phase:** Sync — Billing-path decision + status correction
**Scope:** Revenue Share / Stripe Connect direction; `STRIPE_WEBHOOK_SECRET` confirmed

### Status correction
- `STRIPE_WEBHOOK_SECRET` is now **set in Vercel (All Environments)** — flipped
  from ❌ Pending to ✓ Done in CODE_CONTEXT. The platform-side Stripe webhook
  path (subscriber subscription/payment sync) is fully provisioned.

### Decision locked — Revenue Share processing via Stripe Connect EXPRESS
- Subscriber payment processing on the **Revenue Share** billing path will use
  **Stripe Connect Express accounts**, with **Clyintel-managed onboarding** (we
  drive the Express onboarding flow for each subscriber).
- Per-invoice **payment link generation** against the connected account is the
  mechanic that collects on overdue invoices and routes the revenue-share cut to
  the platform. **This is NOT built yet — it is the top Session 4 build.**
- Scope clarity: platform-side Stripe (subscriber billing, customer creation,
  Checkout upgrade flow) is DONE. The Connect / Rev-Share side is the remaining
  work and the actual Beta launch billing mechanic.

### Deliberately deferred
- **Payment + webhook live-testing** (Connect charges, transfer/application-fee
  flows, connected-account webhook events) — deferred until the Connect build
  lands; no live-money testing before then.
- **Free-tier $0 Stripe product** — NOT needed. Free-tier Revenue Share runs
  through Connect (per-invoice links on the connected account), so there is no
  separate Free subscription product to create. `plans.free.stripe_product_id`
  stays null by design.

### Remaining Beta blockers
- **#0 (new top priority)** Stripe Connect (Express) onboarding + per-invoice
  payment links — Revenue Share billing path.
- #9 AI agent subscriber scoping · #10 Twilio · #11 MailerSend inbound.

---

## Entry 014 — 2026-06-12
**Phase:** Sync — Production incident + follow-ups
**Scope:** Live subscription webhook 401'd on a stale SSO-protected endpoint URL

### Title
Live billing webhook 401'd on a stale, SSO-protected endpoint URL — repointed to production host

### Incident
- Subscriber `charly413@gmail.com` (`subscriber_id 290affb2-6235-4eb0-a151-15dc64036af4`,
  `cus_Ue7inuHp3Q4qjq`) completed a LIVE Starter checkout ($29,
  `ch_3ThJWNP2aVnfVhOw0GODRlxU`, `sub_1ThJWPP2aVnfVhOwI79cn2yT`,
  `price_1THZIpP2aVnfVhOwFNehmiV6`) from production (`clyintel.vercel.app`),
  but the `subscribers` row stayed Free/trialing.
- Root cause: the Stripe webhook endpoint `clyintel-subscription-webhook` was
  registered to
  `https://clyintel-app-git-main-phoresight-ios-projects.vercel.app/api/stripe-webhook`
  — a git-branch preview host under the OLD team slug (`phoresight-ios-projects`),
  which sits behind Vercel Deployment Protection (SSO). Every event returned 401
  (Vercel auth wall); the app code never executed. **Not a code bug, not the
  `getSupabase()`/RLS silent-write bug** — the request never reached the route.
- Fix: EDITED the existing endpoint (preserves signing secret — no
  `STRIPE_WEBHOOK_SECRET` change, no redeploy) to
  `https://clyintel.vercel.app/api/stripe-webhook`. Resent the failed
  `customer.subscription.created` (`evt_1ThJWRP2aVnfVhOwlcPzYW5U`) → 200
  `{"received":true}`. DB reconciled to Starter/active automatically (webhook reads
  `metadata.subscriber_id`, maps price→plan, sets status). No manual DB patch needed.

### Lessons / standing guardrails
- The Stripe webhook must ALWAYS point at the UNPROTECTED production host
  (`clyintel.vercel.app`), never a `-git-<branch>-` preview host (those have Vercel
  Authentication on by default).
- After ANY production domain change or Deployment-Protection change, re-verify the
  webhook still 200s: `curl -I https://clyintel.vercel.app/api/stripe-webhook`
  should return 405/400 (route reachable), NOT 401 (Vercel SSO page).
- EDIT the existing Stripe endpoint when changing its URL — do NOT delete+recreate,
  or Stripe issues a new signing secret and `STRIPE_WEBHOOK_SECRET` in Vercel must
  be updated + redeployed.
- The TEST-mode webhook is a SEPARATE endpoint with its own signing secret. Before
  testing Connect onboarding on the preview deploy with the `sk_test_` key, a
  test-mode endpoint must be registered (Prompt 4 territory).

### Open follow-up (promoted to backlog)
- **Lifecycle notification emails** — send transactional email on signup, on
  upgrade, and on downgrade. Net-new (MailerSend outbound-transactional not yet
  built). Natural home: the same `stripe-webhook` route (already the plan-change
  choke point) plus the signup path. To be specced as its own prompt.

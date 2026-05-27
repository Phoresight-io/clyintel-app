# CODE_CONTEXT.md — clyintel
_Live architectural map. Update after each Claude Code session._
_Last updated: 2026-05-27_

---

## Stack

| Layer | Tool | Notes |
|---|---|---|
| App framework | Next.js 16 (App Router) | TypeScript only. All files `.ts` / `.tsx`. |
| Database | Supabase (Postgres 17) · `clyintel-dev` (`mhvuqjryesjsrictesuk`) | 16 migrations applied. RLS enabled, policies not yet written. |
| Auth | Supabase Auth | **Not yet built.** Email/password + Google OAuth. Middleware not yet in place. |
| Edge Functions | Supabase Edge Functions | **None built yet.** Replaces all retired Make scenarios. |
| Billing | Stripe live mode · `acct_1RfpP0P2aVnfVhOw` | Write ops via Claude Code on local machine. |
| Email delivery | MailerSend | Configured. Inbound routing not yet confirmed. |
| SMS | Twilio | Route built (`/api/sms-reply`). Account + phone number setup pending. |
| Voice | Vapi | Live (demo-scoped). Subscriber-scoped calls are Phase 2. |
| AI agents | Anthropic API · `claude-sonnet-4-6` | Live for demo. Not yet subscriber-scoped. |
| Hosting | Vercel | Live at git-main URL. Confirm production branch = `main`. |
| Accounting sync | QuickBooks via Make (strategic only) | QBO OAuth app not yet registered. |

---

## Repo structure

```
clyintel-app/
├── CLAUDE.md                          # Root Open D3 config
├── clyintel_after.jsx                 # Original prototype — source of truth for UI reference
├── clyintel/
│   ├── CLAUDE.md                      # Product-level config
│   ├── package.json                   # Next.js 16, React 19, TypeScript, Supabase JS
│   ├── app/
│   │   ├── layout.tsx                 # Root layout — Inter + JetBrains Mono, AppShell
│   │   ├── globals.css
│   │   ├── page.tsx                   # / → DashboardScreen (mock data)
│   │   ├── portfolio/page.tsx         # /portfolio → ClientListScreen (mock data)
│   │   ├── client/[id]/page.tsx       # /client/[id] → DetailScreen (mock data)
│   │   ├── connections/page.tsx       # /connections → ConnectionsScreen
│   │   ├── settings/page.tsx          # /settings → IntegrationsScreen
│   │   ├── import/page.tsx            # /import → CSV import flow
│   │   └── api/
│   │       ├── auth/google/callback/route.ts  # Google OAuth callback (needs rewire to Supabase Auth)
│   │       ├── email-reply/route.ts           # MailerSend inbound → Claude → reply
│   │       ├── sms-reply/route.ts             # Twilio inbound → Claude → TwiML
│   │       ├── start-demo/route.ts            # Vapi outbound call trigger
│   │       └── import-invoices/route.ts       # CSV import → Supabase demo_sessions
│   ├── components/
│   │   ├── shell/AppShell.tsx
│   │   ├── dashboard/
│   │   │   ├── DashboardScreen.tsx
│   │   │   ├── NegotiationActions.tsx
│   │   │   └── RecoveryRecModal.tsx
│   │   ├── portfolio/ClientListScreen.tsx
│   │   ├── detail/
│   │   │   ├── ClientDetailWrapper.tsx
│   │   │   ├── DetailScreen.tsx
│   │   │   └── PTRWidget.tsx
│   │   ├── connections/ConnectionsScreen.tsx
│   │   ├── settings/IntegrationsScreen.tsx
│   │   └── shared/ExchangeDrawer.tsx
│   ├── lib/
│   │   ├── theme.ts                   # C token object (colors, fonts)
│   │   ├── mock-data.ts               # All mock arrays — to be replaced by Supabase queries
│   │   ├── demo-mode.ts               # Demo reset/restore localStorage helpers
│   │   ├── supabase.ts                # getSupabase() + getPublicSupabase() — wired, unused in UI
│   │   └── csv-parser.ts
│   ├── types/supabase.ts              # Generated Supabase types — do not edit manually
│   └── schema/README.md
└── .ai/
    ├── CONSTITUTION.md
    ├── SOURCES.md                     # This update — stack decisions, archived tools
    └── clyintel/
        ├── PRODUCT_CONTEXT.md
        ├── CODE_CONTEXT.md            # This file
        ├── FEEDBACK_LOOP.md
        └── specs/
            ├── demo-build-spec.md
            └── TEST_SPEC.md           # New — see below
```

---

## Supabase schema

Project: `clyintel-dev` (`mhvuqjryesjsrictesuk`) — us-east-1, Postgres 17

### Enums (current)

| Enum | Values | Notes |
|---|---|---|
| `plan_tier` | free · starter · plus · pro · enterprise | ✅ Correct |
| `billing_path` | revenue_share · ~~payg~~ | **Remove `payg` — migration required** |
| `invoice_status` | draft · sent · partial · paid · overdue · in_recovery · written_off | ✅ Correct |
| `payment_status` | pending · succeeded · failed · refunded | ✅ Correct |
| `communication_channel` | email · sms · voice | ✅ Correct |
| `communication_direction` | outbound · inbound | ✅ Correct |
| `integration_provider` | stripe · quickbooks · twilio · mailersend | ✅ Correct |
| `ptr_risk_level` | low · medium · high · critical | ✅ Correct |
| `recovery_status` | scheduled · sent · replied · resolved · failed · skipped | ✅ Correct |

### Tables (12 total)

| Table | Rows | RLS | Policies | Notes |
|---|---|---|---|---|
| `plans` | 5 | ✅ Enabled | ❌ Not written | Read-only for all authenticated users |
| `subscribers` | 0 | ✅ Enabled | ❌ Not written | Primary auth anchor — `id` = Supabase Auth `auth.uid()` |
| `clients` | 0 | ✅ Enabled | ❌ Not written | `subscriber_id` FK present |
| `invoices` | 0 | ✅ Enabled | ❌ Not written | `subscriber_id` FK present |
| `payments` | 0 | ✅ Enabled | ❌ Not written | `subscriber_id` FK present |
| `invoice_payments` | 0 | ✅ Enabled | ❌ Not written | Scoped via `invoice_id` → `invoices.subscriber_id` |
| `templates` | 0 | ✅ Enabled | ❌ Not written | System defaults: `subscriber_id` = null |
| `communications` | 0 | ✅ Enabled | ❌ Not written | `subscriber_id` FK present |
| `ptr_scores` | 0 | ✅ Enabled | ❌ Not written | `subscriber_id` FK present |
| `recovery_attempts` | 0 | ✅ Enabled | ❌ Not written | `subscriber_id` FK present |
| `connected_accounts` | 0 | ✅ Enabled | ❌ Not written | `subscriber_id` FK present |
| `demo_sessions` | 8 | ✅ Enabled | ❌ Not written | Demo only — no subscriber_id |
| `audit_log` | — | — | — | **Does not exist yet — must be created** |

---

## Architectural state

### What exists and works
- Next.js 16 app — 6 routes, all rendering correctly on mock data
- Supabase project fully provisioned — schema, types, client wired
- Supabase client (`lib/supabase.ts`) — `getSupabase()` server-side, `getPublicSupabase()` client-side
- AI email agent — MailerSend inbound → Claude → reply (demo-scoped, `airtable_subscriber_id: 'demo'`)
- AI SMS agent — Twilio webhook → Claude → TwiML (demo-scoped)
- AI voice agent — Vapi outbound calls (demo-scoped)
- Stripe products live — 4 tiers, prices set
- Vercel deployment live

### What does not exist yet (Beta blockers — in priority order)

| # | Item | Blocks |
|---|---|---|
| 1 | Supabase Auth — email/password + Google OAuth | Everything subscriber-facing |
| 2 | Auth middleware — protect all routes except `/login`, `/api/stripe-webhook` | Data isolation |
| 3 | RLS policies — all 12 tables | Data isolation |
| 4 | `audit_log` table + policies | AI agent safety |
| 5 | `billing_path` enum — remove `payg` | Schema correctness |
| 6 | Subscriber record creation on signup | Onboarding |
| 7 | Stripe Checkout → webhook → subscriber record | Money path |
| 8 | Replace mock data with Supabase queries (scoped to `auth.uid()`) | Real data in portal |
| 9 | AI agent subscriber scoping (replace `'demo'` hardcode) | Agents safe for real subscribers |
| 10 | Twilio account + phone number | SMS agent live |
| 11 | MailerSend inbound routing | Email agent live |
| 12 | Stripe webhook re-pointed from Make to Next.js API route | Billing events flow |

### What is intentionally deferred (not Beta blockers)
- Supabase Edge Functions (reminder sequences, scoring) — Phase 2
- Vitest + Playwright test suite — configure after auth session
- QBO OAuth — Phase 2
- Vapi subscriber-scoped voice — Phase 2
- FreshBooks / Xero integrations — Phase 2

---

## Coding conventions

Sourced from `.ai/CONSTITUTION.md`. Authoritative copy lives there.

1. TypeScript always. No `.js` files.
2. No IIFE inside JSX. All logic to component top level before `return`.
3. No secrets in version control. All secrets in `.env.local`.
4. Stripe writes via Claude Code on local machine.
5. Supabase migrations via `apply_migration` MCP tool only. No raw DDL in production.
6. Edge Functions in TypeScript, deployed via Supabase MCP.
7. All AI calls via Anthropic API. Default `claude-sonnet-4-6`.
8. Merge field syntax: `{{double_braces_lowercase}}`.
9. Every API route that touches subscriber data must extract `auth.uid()` from the session and scope all queries to that user — even when using the service role client.
10. Every AI-initiated write must log to `audit_log` before any other table write.

---

## Environment variables

| Variable | Location | Status |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel + `.env.local` | ✅ Set |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel + `.env.local` | ✅ Set |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel + `.env.local` | ✅ Set |
| `Anthrop_API_Key` | Vercel | ✅ Set (non-standard name — roadmap: rename to `ANTHROPIC_API_KEY`) |
| `MAILERSEND_API_KEY` | Vercel | ✅ Set |
| `VAPI_API_KEY` | Vercel | ✅ Set |
| `VAPI_ASSISTANT_ID` | Vercel | ✅ Set |
| `VAPI_PHONE_NUMBER_ID` | Vercel | ✅ Set |
| `STRIPE_SECRET_KEY` | `.env.local` only | ✅ Set locally |
| `STRIPE_WEBHOOK_SECRET` | To be set | ❌ Pending |
| `TWILIO_ACCOUNT_SID` | To be set | ❌ Pending |
| `TWILIO_AUTH_TOKEN` | To be set | ❌ Pending |
| `TWILIO_PHONE_NUMBER` | To be set | ❌ Pending |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | To be set | ❌ Required for Google OAuth |
| `GOOGLE_CLIENT_SECRET` | To be set | ❌ Required for Google OAuth |

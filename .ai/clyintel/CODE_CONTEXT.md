# CODE_CONTEXT.md — clyintel
_Live architectural map. Update after each Claude Code session._
_Last updated: 2026-05-18_

---

## Stack

| Layer | Tool | Notes |
|---|---|---|
| App framework | Next.js 16 (App Router) | TypeScript only. All files `.ts` / `.tsx`. |
| Database | Supabase (Postgres) | Migrations via `apply_migration` MCP tool. Types generated via `supabase gen types`. |
| Edge Functions | Supabase Edge Functions | TypeScript. Deployed via Supabase MCP. Replaces all retired Make scenarios. |
| Billing | Stripe | Live mode — `acct_1RfpP0P2aVnfVhOw`. Write ops via Claude Code on local machine. |
| Email | MailerSend | Templates not yet validated. |
| SMS | Twilio | Account setup pending. |
| AI agents | Anthropic API | Default: `claude-sonnet-4-6`. Escalate to Opus for complex reasoning. Env var: `Anthrop_API_Key`. |
| Subscriber portal | Softr | Reconnection to Supabase via REST API pending. |
| Demo deployment | Vercel | Live — https://clyintel-app-git-main-phoresight-ios-projects.vercel.app |

---

## Repo Structure

```
clyintel-app/
├── CLAUDE.md                        # Root Open D3 config — stack, commands, agent rules
├── clyintel_after.jsx               # Original prototype (source of truth for demo)
├── clyintel/
│   ├── CLAUDE.md                    # Product-level config — overrides root
│   ├── .gitignore                   # Excludes .next/ and node_modules/
│   ├── package.json                 # Next.js 16, React, TypeScript
│   ├── tsconfig.json
│   ├── next.config.ts
│   ├── app/
│   │   ├── layout.tsx               # Root layout — Inter + JetBrains Mono, AppShell wrapper
│   │   ├── globals.css              # Reset + keyframes
│   │   ├── page.tsx                 # / → DashboardScreen
│   │   ├── portfolio/
│   │   │   └── page.tsx             # /portfolio → ClientListScreen
│   │   └── client/[id]/
│   │       └── page.tsx             # /client/[id] → DetailScreen
│   ├── components/
│   │   ├── shell/
│   │   │   └── AppShell.tsx         # Nav (active via usePathname) + footer
│   │   ├── dashboard/
│   │   │   ├── DashboardScreen.tsx  # KPI cards, rec panel, sortable invoice table
│   │   │   ├── NegotiationActions.tsx
│   │   │   └── RecoveryRecModal.tsx
│   │   ├── portfolio/
│   │   │   └── ClientListScreen.tsx # Summary cards + client table
│   │   ├── detail/
│   │   │   └── DetailScreen.tsx     # PTR widget, invoice summary, history table
│   │   └── shared/
│   │       └── ExchangeDrawer.tsx   # Slide-in exchange history drawer
│   ├── lib/
│   │   ├── theme.ts                 # C token object (colors, fonts as CSS vars)
│   │   └── mock-data.ts             # All mock arrays with TypeScript types
│   ├── types/
│   │   └── README.md                # supabase.ts goes here when generated
│   └── schema/
│       └── README.md                # Migration history docs
└── .ai/
    ├── CONSTITUTION.md              # Engineering standards and code rules
    ├── SOURCES.md                   # Registered integrations and archived sources
    └── clyintel/
        ├── PRODUCT_CONTEXT.md       # Full product spec — tiers, rules, IDs
        ├── CODE_CONTEXT.md          # This file — live architectural map
        ├── FEEDBACK_LOOP.md         # Append-only delivery log
        └── specs/
            └── demo-build-spec.md   # Approved spec for demo build
```

---

## Coding Conventions

Sourced from `.ai/CONSTITUTION.md`. Authoritative copy lives there.

1. **TypeScript always.** No `.js` files. App Router conventions throughout.
2. **No IIFE inside JSX.** All logic moved to component top level before `return`.
3. **No secrets in version control.** All secrets in `.env.local`.
4. **Stripe writes via Claude Code on local machine.** Escalate if Stripe MCP fails.
5. **Supabase migrations via `apply_migration` only.** No raw DDL in production.
6. **Edge Functions in TypeScript, deployed via Supabase MCP.**
7. **All AI calls via Anthropic API.** Default `claude-sonnet-4-6`, Opus for complex reasoning.
8. **Merge field syntax:** `{{double_braces_lowercase}}` — never single braces, never uppercase.

---

## Supabase Schema

Project: `clyintel-dev` (`mhvuqjryesjsrictesuk`) — region `us-east-1`, Postgres 17

### Enums
| Enum | Values |
|---|---|
| `plan_tier` | free · starter · plus · pro · enterprise |
| `billing_path` | revenue_share · payg |
| `invoice_status` | draft · sent · partial · paid · overdue · in_recovery · written_off |
| `payment_status` | pending · succeeded · failed · refunded |
| `communication_channel` | email · sms · voice |
| `communication_direction` | outbound · inbound |
| `integration_provider` | stripe · quickbooks · twilio · mailersend |
| `ptr_risk_level` | low · medium · high · critical |
| `recovery_status` | scheduled · sent · replied · resolved · failed · skipped |

### Tables
| Table | Rows | Notes |
|---|---|---|
| `plans` | 5 | Seeded — all tiers. FK target for `subscribers.plan_id`. |
| `subscribers` | 0 | Tracks billing path, usage counters, feature flags, QBO tokens. |
| `connected_accounts` | 0 | Per-subscriber OAuth credentials (Stripe, QBO, Twilio, MailerSend). |
| `clients` | 0 | Denormalized totals (`total_invoiced_cents` etc.) updated by triggers. |
| `invoices` | 0 | Generated column `amount_outstanding_cents = amount_cents - amount_paid_cents`. |
| `payments` | 0 | Stripe payment intents + charges. |
| `invoice_payments` | 0 | Bridge table — allocates payments to invoices. |
| `templates` | 0 | Email/SMS templates. System defaults (`is_system_default`) shared across subscribers. |
| `communications` | 0 | Outbound + inbound log. Tracks MailerSend/Twilio message IDs and AI interpretation. |
| `ptr_scores` | 0 | AI-generated client risk scores with composite scoring inputs. |
| `recovery_attempts` | 0 | One row per recovery action. Tracks revenue share per attempt. |
| `demo_sessions` | 8 | Demo AI conversation sessions (name, phone, scenario 1–3, history). |

---

## Architectural State

### What exists
- Open D3 framework files (`.ai/` scaffolding, root and product `CLAUDE.md`)
- Next.js 16 demo app — 3 routes, mock data, no auth
- Supabase project `clyintel-dev` — full schema applied (16 migrations), plans seeded
- Supabase TypeScript types — `clyintel/types/supabase.ts`
- Live on Vercel: https://clyintel-app-git-main-phoresight-ios-projects.vercel.app
- Airtable table and field IDs preserved in `PRODUCT_CONTEXT.md` for migration mapping

### What does not exist yet
- Supabase client wired into Next.js app (no `@supabase/supabase-js` installed yet)
- Any Edge Functions
- Twilio account and phone number
- Anthropic API key
- MailerSend inbound routing

### Retired (do not reference in new code)
- Airtable as operational database — replaced by Supabase
- Make automation scenarios — replaced by Supabase Edge Functions

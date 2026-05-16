# CODE_CONTEXT.md — clyintel
_Live architectural map. Update after each Claude Code session._
_Last updated: 2026-05-16_

---

## Stack

| Layer | Tool | Notes |
|---|---|---|
| App framework | Next.js (App Router) | TypeScript only. All files `.ts` / `.tsx`. |
| Database | Supabase (Postgres) | Migrations via `apply_migration` MCP tool. Types generated via `supabase gen types`. |
| Edge Functions | Supabase Edge Functions | TypeScript. Deployed via Supabase MCP. Replaces all retired Make scenarios. |
| Billing | Stripe | Live mode — `acct_1RfpP0P2aVnfVhOw`. Write ops via Claude Code on local machine. |
| Email | MailerSend | Templates not yet validated. |
| SMS | Twilio | Account setup pending. |
| AI agents | Anthropic API | Default: `claude-sonnet-4-6`. Escalate to Opus for complex reasoning. |
| Subscriber portal | Softr | Reconnection to Supabase via REST API pending. |
| Demo deployment | Vercel | Repo connection to `clyintel-app` pending. |

---

## Repo Structure

```
clyintel-app/
├── CLAUDE.md                        # Root Open D3 config — stack, commands, agent rules
├── clyintel/
│   ├── CLAUDE.md                    # Product-level config — overrides root
│   ├── app/                         # Next.js App Router entry (not yet scaffolded)
│   ├── types/
│   │   └── README.md                # supabase.ts goes here when generated
│   └── schema/
│       └── README.md                # Migration history and Airtable field mapping docs
└── .ai/
    ├── CONSTITUTION.md              # Engineering standards and code rules
    ├── SOURCES.md                   # Registered integrations and archived sources
    └── clyintel/
        ├── PRODUCT_CONTEXT.md       # Full product spec — tiers, rules, IDs
        ├── CODE_CONTEXT.md          # This file — live architectural map
        └── FEEDBACK_LOOP.md         # Append-only delivery log
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

## Architectural State

### What exists
- Open D3 framework files (`.ai/` scaffolding, root and product `CLAUDE.md`)
- Airtable table and field IDs preserved in `PRODUCT_CONTEXT.md` for migration mapping

### What does not exist yet
- Next.js app scaffold (`clyintel/app/`)
- Supabase project and initial schema migration
- Supabase types (`clyintel/types/supabase.ts`)
- Any Edge Functions
- Twilio, Anthropic API, or Vercel connections

### Retired (do not reference in new code)
- Airtable as operational database — replaced by Supabase
- Make automation scenarios — replaced by Supabase Edge Functions

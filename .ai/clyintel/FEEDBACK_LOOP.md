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
- Vercel `clyintel-app.vercel.app` 404: Root cause identified — production branch still set to `claude/setup-open-d3-framework-fAvPt`. Vercel API PATCH attempts failed (endpoint rejected both `link` and `productionBranch` properties). Dashboard setting location not found. Carrying forward.

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

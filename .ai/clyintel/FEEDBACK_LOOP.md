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

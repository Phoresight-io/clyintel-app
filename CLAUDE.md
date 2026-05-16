# CLAUDE.md
_Open D3 root configuration — clyintel-app_
_Generated: 2026-05-16_

---

## Active Product

Product folder: `clyintel`

---

## Stack

| Layer | Tool |
|---|---|
| App framework | Next.js |
| Language | TypeScript |
| Database | Supabase (Postgres) |
| Operational DB | Airtable (`appB9RBtlceibhEqn`) |
| Automation | Make (team `1596669`) |
| Billing | Stripe (live mode, `acct_1RfpP0P2aVnfVhOw`) |
| Email | MailerSend |
| Subscriber portal | Softr |

---

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Build | `npm run build` |
| Type check | `npx tsc --noEmit` |
| Lint | `npm run lint` |
| Tests | _(not configured yet)_ |

---

## Test Framework

Not configured yet. Update this file when a test framework is chosen.

---

## Key File Locations
**IMPORTANT**: Always read `clyintel/CLAUDE.md` before starting any task. That file overrides this one for anything product-specific.

| What | Where |
|---|---|
| Product config | `clyintel/CLAUDE.md` |
| Next.js entry | `clyintel/app/` |
| Shared types | `clyintel/types/` |
| Schema history | `clyintel/schema/` |
| Supabase types | `clyintel/types/supabase.ts` |

---

## AGENTS / AI RULES

All agents must follow these rules unless the product CLAUDE.md explicitly overrides:

1. Read `clyintel/CLAUDE.md` before any task.
2. Do not create top-level folders outside the product folder.
3. Do not create root-level config files without explicit user approval.
4. Prefer editing existing files before creating new ones.
5. Never hardcode secrets. Use `.env.local` for development.
6. Do not invent schema. Check `clyintel/schema/` or confirm with the user.
7. For any billing or payment logic, confirm with the user before implementing.

---

## Open D3 Pipeline Entry Points

- **Start a feature:** "Run the Open D3 pipeline for: [feature]. Product: clyintel"
- **Discovery only:** "Start discovery for: [idea]. Product: clyintel"
- **Verify a spec:** "Generate test skeletons from the approved spec. Product: clyintel"
- **Sync after shipping:** "Tests are passing — run the sync phase. Product: clyintel"

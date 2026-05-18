# CLAUDE.md
_Open D3 product configuration — clyintel_
_Generated: 2026-05-16 · Updated: 2026-05-18_

---

## Product Overview

**Product**: ClyIntel
**Slug**: `clyintel`
**Description**: AI-powered accounts receivable and collections intelligence platform for solopreneurs and small businesses. Recovers overdue receivables through automated outreach and predictive insights — no manual follow-up required.
**Positioning**: Payment Intelligence Built for Small Businesses — sell outcomes, not AI.

---

## Stack (product-specific overrides)

_Inherits from root CLAUDE.md. No overrides at this time._

---

## Supabase Schema (source of truth for app data)

Project: `clyintel-dev` (`mhvuqjryesjsrictesuk`) — us-east-1, Postgres 17  
Types: `clyintel/types/supabase.ts` (generated 2026-05-18)

Core tables: `plans` · `subscribers` · `clients` · `invoices` · `payments` · `invoice_payments` · `templates` · `communications` · `ptr_scores` · `recovery_attempts` · `connected_accounts` · `demo_sessions`

All tables have RLS enabled. `plans` is seeded (5 rows). See `.ai/clyintel/CODE_CONTEXT.md` for full schema detail.

---

## Key Decisions

| Decision | Detail |
|---|---|
| Auth | To be confirmed |
| Data sync strategy | To be confirmed |
| AI provider | Anthropic API — `claude-sonnet-4-6` default |

---

## Known Constraints

- Stripe account is in **live mode**. Do not run test transactions against the live account without explicit approval.
- MailerSend is the email provider. Do not add SendGrid, Resend, or other email providers without approval.
- Softr handles the subscriber portal. Do not duplicate this in the Next.js app without approval.
- Airtable is **retired as operational DB**. Table/field IDs in `PRODUCT_CONTEXT.md` are migration reference only — do not write new Airtable integration code.

---

## Agent Rules (product-level)

1. Read `.ai/clyintel/PRODUCT_CONTEXT.md` for full tier definitions, business rules, and Stripe IDs.
2. Do not add new npm packages without confirming with the user.
3. Keep AI-generated code clearly separated from manually written code where possible.
4. Do not write Airtable integration code. Supabase is the operational database.

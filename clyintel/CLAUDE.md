# CLAUDE.md
_Open D3 product configuration — clyintel_
_Generated: 2026-05-16_

---

## Product Overview

**Product**: ClyIntel  
**Description**: An intelligence briefing tool for sales teams. Pulls data from multiple sources and surfaces key insights in a clean UI.

---

## Stack (product-specific overrides)

_Inherits from root CLAUDE.md. No overrides at this time._

---

## Airtable Schema (source of truth for CRM/ops data)

**Base**: `appB9RBtlceibhEqn`

| Table | Table ID | Key Fields |
|---|---|---|
| Companies | _(confirm before use)_ | name, domain, industry, tier |
| Contacts | _(confirm before use)_ | name, email, company_id, role |
| Briefings | _(confirm before use)_ | company_id, date, status, content |

> **Rule**: Do not make assumptions about Airtable table or field IDs. Confirm by reading schema or calling the Airtable MCP tool before any Airtable-related code.

---

## Supabase Schema (source of truth for app data)

_No tables confirmed yet. Update this file when schema is established._

---

## Key Decisions

| Decision | Detail |
|---|---|
| Auth | To be confirmed |
| Data sync strategy | To be confirmed |
| AI provider | To be confirmed |

---

## Known Constraints

- Stripe account is in **live mode**. Do not run test transactions against the live account without explicit approval.
- MailerSend is the email provider. Do not add SendGrid, Resend, or other email providers without approval.
- Softr handles the subscriber portal. Do not duplicate this in the Next.js app without approval.

---

## Agent Rules (product-level)

1. Always check Airtable schema before writing any Airtable integration code.
2. Do not add new npm packages without confirming with the user.
3. Keep AI-generated code clearly separated from manually written code where possible.

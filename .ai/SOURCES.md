# SOURCES.md
_Open D3 registered sources — clyintel_
_Generated: 2026-05-16_

---

## Registered Sources

### GitHub
- App repo: `Phoresight-io/clyintel-app` — accessible via GitHub MCP ✅
- Ops repo: `Phoresight-io/clyintel-ops` (PRD, backlog, progress) — not yet in MCP scope ⚠️
- AI ops repo: `Phoresight-io/phoresight-clyintel-ai-ops` — not yet in MCP scope ⚠️
- Role: Cross-session source of truth
- GH-01 status: Partially resolved. Connector now reaches `clyintel-app`. Add `clyintel-ops` and `phoresight-clyintel-ai-ops` via environment settings at code.claude.com to complete.

### Supabase
- Role: Operational database + Edge Functions
- Access: Supabase MCP
- Note: Project ref to be added once confirmed

### Stripe
- Account: `acct_1RfpP0P2aVnfVhOw` (live mode)
- Role: Subscription billing, payment processing
- Access: Stripe MCP (restricted key — write ops may require Claude Code on local machine)
- Webhook: Hook ID `2102939` · Endpoint currently points to Make (temporary — must move to Next.js API route after Vercel deployment)

### Twilio
- Role: SMS delivery + inbound
- Access: Twilio API
- Note: Account SID to be added

### Anthropic API
- Role: AI recovery agent, PTR recommendations
- Default model: `claude-sonnet-4-6`
- Note: API key to be obtained from console.anthropic.com

### Vercel
- Role: Demo deployment
- Note: Connect `clyintel-app` GitHub repo

---

## Archived Sources

### Airtable _(migration reference only)_
- Base ID: `appB9RBtlceibhEqn`
- Status: **Retired as operational DB.** Supabase is the operational database.
- Note: Table and field IDs preserved in `PRODUCT_CONTEXT.md` for data migration mapping only.

### Make _(retired)_
- Team ID: `1596669` · Org `5781580`
- Status: **Retired.** All 7 scenarios superseded by Supabase Edge Functions.
- Archived scenarios: 4528004 · 4528009 · 4528019 · 4528024 · 4612729 · 4612731 · 4612732

---

## Sources Not Yet Configured

| Source | Notes |
|---|---|
| MailerSend | Templates not yet validated |
| Softr | Portal build not started — will reconnect to Supabase via REST API |
| QuickBooks Online | Phase 1 integration via Edge Function — pending QBO OAuth app registration |

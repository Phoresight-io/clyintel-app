# SOURCES.md
_Open D3 registered sources — clyintel_
_Generated: 2026-05-16_

---

## Registered Sources

### GitHub
- Repos: `Phoresight-io/clyintel-ops` (PRD, backlog, progress) · `phoresight-clyintel-ai-ops` (AI ops)
- App repo: `clyintel-app`
- Role: Cross-session source of truth
- Note: GitHub MCP connector currently scoped to `claude-remote-control` — fix pending (GH-01)

### Airtable
- Base ID: `appB9RBtlceibhEqn`
- Role: All operational data
- Access: Airtable MCP

### Stripe
- Account: `acct_1RfpP0P2aVnfVhOw` (live mode)
- Role: Subscription billing, payment processing
- Access: Stripe MCP (restricted key — write ops may require Claude Code on local machine)
- Webhook: Hook ID `2102939` · https://hook.us2.make.com/6ycqb709agtxko74vktsg6qeh25445fs

### Make
- Team ID: `1596669` · Org `5781580`
- Role: Workflow automation, event processing
- Active scenarios: 4528004 · 4528009 · 4528019 · 4528024 · 4612729 · 4612731 · 4612732

---

## Sources Not Yet Configured

| Source | Notes |
|---|---|
| MailerSend | Templates not yet validated |
| Softr | Portal build not started |
| QuickBooks Online | Phase 1 integration via Make — pending |

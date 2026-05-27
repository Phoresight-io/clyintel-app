# SOURCES.md
_Open D3 registered sources — clyintel_
_Updated: 2026-05-27 · Supersedes previous version_

---

## Decision log — this update

| Decision | Detail |
|---|---|
| Vapi confirmed | Voice agent vendor locked. Vapi is permanent, not provisional. |
| PAYG billing path removed | `billing_path` enum cleaned to `revenue_share` only at launch. `payg` is a roadmap item — do not re-add without a product decision. |
| Google OAuth confirmed | Auth stack: Supabase Auth + email/password + Google OAuth. No other providers. |
| Airtable fully retired | No new Airtable code. IDs in PRODUCT_CONTEXT.md are migration reference only. |
| Make fully retired | No new Make scenarios. QBO OAuth sync is the single exception — see below. |
| Softr fully retired | No subscriber portal work in Softr. All portal work is in Next.js. |

---

## Active sources

### GitHub
- App repo: `Phoresight-io/clyintel-app` — source of truth for all code
- Ops repo: `Phoresight-io/clyintel-ops` — PRD, backlog, progress
- AI ops repo: `Phoresight-io/phoresight-clyintel-ai-ops` — working ops repo
- GitHub App permissions: All repositories ✅
- Note: Claude Code session scope is one repo per session (platform limitation)

### Supabase
- Project: `clyintel-dev` · ref `mhvuqjryesjsrictesuk` · region `us-east-1` · Postgres 17
- Role: Operational database + Edge Functions (Edge Functions not yet built)
- Access: Supabase MCP
- Schema status: 16 migrations applied, 12 tables, plans seeded, RLS enabled on all tables
- RLS policies: NOT YET WRITTEN — must be written before any real subscriber data is stored
- Audit log table: NOT YET CREATED — required before Beta launch

### Stripe
- Account: `acct_1RfpP0P2aVnfVhOw` (live mode)
- Role: Subscription billing, payment processing, Revenue Share payment links
- Products: Starter `prod_UG5P6BwawRlmf2` · Plus `prod_UG5Pn5BS7UGHtD` · Pro `prod_UG5Q9TLOQd99ey` · Enterprise `prod_UG5RcrHZXFGLmk`
- Access: Stripe MCP (write ops require Claude Code on local machine)
- Webhook: Currently points to Make (retired) — must be re-pointed to Next.js API route after Vercel deployment
- AR Hunter legacy products: Archived ✅

### Anthropic API
- Role: AI recovery agents (email, SMS, voice), PTR recommendations
- Default model: `claude-sonnet-4-6`
- Escalate to Opus for complex reasoning tasks
- Env var: `Anthrop_API_Key` (set in Vercel)
- Note: Env var name is non-standard — consider renaming to `ANTHROPIC_API_KEY` for convention alignment

### Vapi
- Role: AI voice agent — outbound recovery calls + inbound callback handling
- Status: Live (demo-scoped)
- Env vars: `VAPI_API_KEY` · `VAPI_ASSISTANT_ID` · `VAPI_PHONE_NUMBER_ID`
- Beta work needed: Scope calls to authenticated subscriber context

### Twilio
- Role: SMS delivery + inbound reply handling
- Status: Account setup pending — phone number not yet purchased
- Env var: `TWILIO_ACCOUNT_SID` · `TWILIO_AUTH_TOKEN` · `TWILIO_PHONE_NUMBER` (to be added)
- Webhook route: `/api/sms-reply` (built, awaiting Twilio config)

### MailerSend
- Role: Transactional email delivery + inbound reply handling
- Status: Delivery configured ✅ · Inbound routing not yet confirmed
- Env var: `MAILERSEND_API_KEY` (set in Vercel)
- Inbound webhook route: `/api/email-reply` (built, awaiting inbound routing config)

### Vercel
- Role: Hosting + deployment
- Live URL: `https://clyintel-app-git-main-phoresight-ios-projects.vercel.app`
- Production branch: Confirm set to `main` in Vercel project settings
- Root directory: `clyintel/` ✅

### QuickBooks Online (via Make)
- Role: Invoice ingestion — auto-pull client invoices into Clyintel
- Status: QBO OAuth app not yet registered in QuickBooks Developer portal
- Make: Strategic use only — QBO OAuth flow is the single permitted Make scenario
- All other automation: Supabase Edge Functions

---

## Archived sources — do not reference in new code

### Airtable _(migration reference only)_
- Base ID: `appB9RBtlceibhEqn`
- Status: **Retired as operational DB.** Supabase is the operational database.
- Table and field IDs preserved in `PRODUCT_CONTEXT.md` for data migration mapping only
- Do not write new Airtable integration code

### Make _(mostly retired)_
- Team ID: `1596669` · Org `5781580`
- Status: **Retired** except for QBO OAuth sync
- All 7 original scenarios superseded by Supabase Edge Functions (not yet built)
- Permitted use: QBO OAuth only

### Softr _(fully retired)_
- Status: **Retired.** All subscriber portal work is in Next.js + Supabase.
- Do not build new Softr pages or reconnect to Supabase

---

## Sources not yet configured

| Source | Blocker | Priority |
|---|---|---|
| Supabase Auth (Google OAuth) | Not yet built | P1 — Beta blocker |
| Supabase RLS policies | Not yet written | P1 — Beta blocker |
| Audit log table | Not yet created | P1 — Beta blocker |
| Supabase Edge Functions | None built yet | P1 — replaces Make |
| Twilio phone number | Account setup pending | P1 |
| MailerSend inbound routing | Config pending | P1 |
| QBO OAuth app | Registration pending | P2 |
| Vitest + Playwright | Not yet configured | P2 |

---

## Roadmap items (intentionally deferred)

| Item | Decision |
|---|---|
| PAYG billing path | Removed from launch. Re-evaluate post-Beta based on demand. |
| AI Voice Agent (subscriber-facing) | Vapi demo is live. Subscriber-scoped voice requires auth + Edge Function work. Phase 2. |
| AI SMS Agent (subscriber-facing) | Twilio live requires account setup. Phase 2 alongside Twilio config. |
| FreshBooks integration | Phase 2 |
| Xero integration | Phase 2 |
| Vitest + Playwright test suite | Configure after Beta auth and data wiring sessions |
| White-label reports | Enterprise tier only. Phase 2. |

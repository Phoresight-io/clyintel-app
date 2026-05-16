# CONSTITUTION.md
_Open D3 engineering standards — clyintel-app_
_Generated: 2026-05-16_

---

## Language / Runtime

- **Always TypeScript.** Never plain JavaScript. All new files must be `.ts` or `.tsx`.
- Target: Next.js App Router conventions unless a file explicitly opts out.

---

## Code Rules

1. **No IIFE structures inside JSX.** Move all calculations and logic to the component top level before the return statement.
2. **`typecast: true` required for all Airtable Single Select API calls.**
3. **Rollup fields cannot be created via the Airtable API.** Use Omni or Airtable UI.
4. **Never commit `.env` to version control.** Secrets live in `.env` only.
5. **Stripe write operations use Claude Code on local machine.** Escalate if MCP fails.

---

## Test Framework

Not configured yet. Recommended: Vitest (unit) + Playwright (E2E). Validate with Charles before adding.

---

## Enforcement Policy


```yaml
code_context_staleness: warn_prompt
```


When `CODE_CONTEXT.md` appears out of date, flag it immediately. Do not block — warn and continue.

---

## Compliance

- **PCI-DSS:** Payment processing delegated entirely to Stripe. Clyintel must never store raw card data. PCI scope to be formally verified before launch.
- Financial data (invoice amounts, payment status, subscriber billing) must follow least-privilege access patterns.

---

## Escalation Rules

- If an MCP tool fails once: escalate to the next tool immediately. Do not retry or debug in chat.
- If a task fails more than twice for the same reason: stop and re-scope.
- If the task requires browser UI: use Cowork or Perplexity Computer, not Claude Code.

---

## Merge Field Syntax Standard

`{{double_braces_lowercase}}` — always. Never single braces. Never uppercase.

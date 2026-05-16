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
2. **Never commit `.env` to version control.** Secrets live in `.env` only.
3. **Stripe write operations use Claude Code on local machine.** Escalate if MCP fails.
4. **Supabase migrations must use the `apply_migration` tool.** Never run raw DDL directly in production.
5. **Edge Functions are written in TypeScript and deployed via Supabase MCP.**
6. **All AI calls go through Anthropic API.** Default model: `claude-sonnet-4-6`. Escalate to Opus for complex reasoning.

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

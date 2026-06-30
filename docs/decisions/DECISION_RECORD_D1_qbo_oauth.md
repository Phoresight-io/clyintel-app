# Decision Record — D1: QuickBooks Online OAuth (Capture Detection Phase 2)

**Status:** D1 complete, verified against live QBO sandbox
**Date:** 2026-06-29 10:00 PM EDT
**PR:** #21 (`feat/qbo-oauth-connect`, commit `3d73210`) — pending squash-merge to `main`
**Owner:** Charles Weldon (sole approver of merges + live writes)

---

## What shipped

Native Next.js QuickBooks Online OAuth connect / reconnect flow, replacing the
retired Make QBO-OAuth bridge. Feeds the Phase-1 capture-detection core; does not
modify it.

- `lib/crypto.ts` — AES-256-GCM at-rest secret encryption (`TOKEN_ENCRYPTION_KEY`),
  self-describing `iv.authTag.ciphertext` payload, random 12-byte IV per call.
- `lib/qbo/{constants,oauthState,tokens}.ts` — Intuit endpoints; signed single-use
  HttpOnly state cookie (RFC 9700 CSRF); `getValidAccessToken` with proactive
  5-min-skew refresh + rotated-refresh-token capture.
- `GET /api/qbo/connect | /callback | /status` (runtime=nodejs, force-dynamic).
- QuickBooks card on `/connections` (mirrors Stripe ConnectCard).

---

## Decisions locked (do not re-litigate)

| # | Decision | Rationale |
|---|----------|-----------|
| D1-1 | **Token encryption = app-layer AES-256-GCM** via `TOKEN_ENCRYPTION_KEY` env var (Option A) | No existing crypto helper in repo; D1 is first writer to `connected_accounts`. pgsodium absent. App-layer keeps key out of DB. |
| D1-2 | **CSRF = signed HttpOnly state cookie** (not `oauth_states` table) | RFC 9700-compliant; HttpOnly+Secure+SameSite=Lax, signed, single-use, 10-min TTL. No table needed. |
| D1-3 | **Canonical storage = `connected_accounts`**, keyed `(subscriber_id, provider='quickbooks')` | Legacy `subscribers.qbo_*` columns NEVER written. Single source of truth for integration records. |
| D1-4 | **Realm stored as `connected_accounts.external_id`** | Subscriber-resolution join is `external_id → subscriber_id`. Legacy `subscribers.qbo_realm_id` ignored. |
| D1-5 | **Connections card lives on `/connections`** for now | Existing route. Cosmetic relocation to settings (near `ConnectCard.tsx`) is an optional later follow-up; if moved, update Intuit Launch/Disconnect/Reconnect URLs to match. |

---

## Verification — proven against live sandbox (realmId `9341457364281969`)

| Check | Result |
|-------|--------|
| OAuth round-trip (consent → callback → redirect) | PASS |
| One `connected_accounts` row, `provider='quickbooks'` | PASS |
| Realm stored as `external_id=9341457364281969` | PASS |
| Both tokens stored | PASS |
| Tokens encrypted at rest (AES-GCM ciphertext, not raw JWT) | PASS — prefix `OuGZq518…`, IV-dot at pos 17, len 846 |
| Token expiry ~60 min out | PASS — exactly 60 min |
| Legacy `subscribers.qbo_*` columns untouched | PASS — all null |
| Reconnect updates same row (no duplicate) | PASS — row count stayed 1, `updated_at` advanced |

---

## Environment state at time of D1 (banked for context)

- **Stripe** keys split correctly: `STRIPE_SECRET_KEY` = `sk_live_…` on Production,
  `sk_test_…` on Preview+Dev. `STRIPE_WEBHOOK_SECRET` = All Environments (shared,
  to be split at Connect-Express webhook-test time).
- **QBO** vars currently **All Environments with SANDBOX values**
  (`QBO_ENVIRONMENT=sandbox`). Done to unblock testing given prod/preview share one
  DB. MUST be swapped to production values before first customer (see checklist).
- **Supabase**: Preview and Production currently share ONE project
  (`clyintel-dev`, ref `mhvuqjryesjsrictesuk`). Acceptable now (no customers);
  a real isolation gap before Beta (see checklist).

---

## ⚠️ PRE-BETA CHECKLIST — must clear before first real customer

> These exist because testing convenience now (sandbox-everything on all envs,
> shared DB) trades against production safety later. None are optional at launch.

### Credentials → production
- [ ] **QBO**: swap sandbox → production creds (Client ID/Secret), set
      `QBO_ENVIRONMENT=production`, `QBO_BASE_URL=https://quickbooks.api.intuit.com`,
      scope **Production** only; keep sandbox values on Preview+Dev → redeploy.
- [ ] **QBO**: submit Intuit production review (Part A, step A7) and pass.
- [ ] **Stripe**: live keys already correctly scoped to Production ✅ (no action).
- [ ] **Stripe**: split `STRIPE_WEBHOOK_SECRET` (live secret → Production, test-mode
      secret → Preview+Dev) when webhook testing begins under Connect Express.

### Environment isolation (the durable "test in a lower env" fix)
- [ ] **Supabase**: separate prod vs. dev project (or enable Supabase branching) so
      preview deployments stop writing to the live customer DB. Split the
      `SUPABASE_*` connection env vars Preview→dev / Production→prod, same discipline
      as Stripe keys.
- [ ] Confirm **no preview deployment ever carries live credentials** (QBO, Stripe,
      Supabase) after the splits above.

### Workflow hygiene (prevents the redeploy-to-prod trap)
- [ ] Establish: **prod is reached ONLY by squash-merging a PR** — never by
      manually redeploying a feature branch to production.
- [ ] Test on the **branch-alias preview URL**
      (`clyintel-git-<branch>-phoresight-projects.vercel.app`), which is stable per
      branch, not the per-commit hash URLs.

---

## Immediate next steps

1. **Merge PR #21** — squash-merge in GitHub UI (Charles). Puts QBO code on `main`;
   makes prod legitimately D1 rather than a promoted preview branch.
2. **D2** (next deliverable, not started): QBO webhook endpoint + native adapter.
   Verifier token already captured during Part A (A4) — stash, add to Vercel at D2.
3. Optional: relocate QBO card to settings near `ConnectCard.tsx` (cosmetic).

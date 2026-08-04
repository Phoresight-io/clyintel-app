# Capture Test — Invoice 1038 — Close-Out Record

**Status:** ✅ PASSED & CLOSED
**Date confirmed:** 2026-08-04
**Owner:** Charles Weldon (solo founder) · Product/Ops direction: Claude (chat)

---

## 1. What this test proved

The full **recovery-payments capture bridge** works end-to-end against a **real paid Stripe recovery link**: a debtor paying an overdue invoice through a Clyintel recovery link causes the system to write exactly one revenue-share ledger row recording Phoresight's fee.

This is the core money-capture engine of the product, now proven in Production.

---

## 2. Test fixture (verbatim IDs)

| Thing | Value |
|---|---|
| Invoice | #1038, local uuid `0317e331-dfc4-41e2-b589-38077395d649`, QBO txnId `145` |
| Face value | $3,900.00 (390000 cents) |
| Subscriber | `34205047-14e3-45bb-80e2-2fb8da2da910` (active) |
| Connected Stripe payout acct | `acct_1Thfzc0P3XbvjHNx` (charges + payouts enabled) |
| Recovery link row | `11fdb58f-c35d-4118-9129-84d8cacde518`, type `standard`, token `tvL55g7TjWQoeH5ls39nmrzd3ZSZ6qmGkdAPFOH8Uso` |
| Stripe payment intent | `pi_3U0YL6P2aVnfVhOw1oiSutI0` |
| Stripe charge | `ch_3U0YL6P2aVnfVhOw1RqSf8wU` |
| Stripe checkout session | `cs_test_a1xUJWMjT8taNaogfpNH1EZVo0KtQ9dHjH9o5CAoHGBRg1EtX6avCCEuIO` |
| Stripe event | `evt_1U0YL8P2aVnfVhOw5jEHvJyl` |
| Stripe application fee | `fee_1U0YLA0P3XbvjHNxitUpwGWk` = 85800¢ ($858), livemode false |
| Webhook endpoint | `test-recovery-checkout` → `https://clyintel.vercel.app/api/stripe-webhook` (Stripe dest `we_1TpeEFP2aVnfVhOwF2HwyBPg`) |

---

## 3. Final confirmed end state (DB — authoritative)

**`rev_share_ledger`** — exactly ONE row:

| Field | Value |
|---|---|
| id | `ac290e77-2c90-4e55-b3fe-504e03d38dea` |
| source | `stripe_recovery` |
| invoice_number | `1038` |
| invoice_ref | `145` |
| band / rate | band1 / 0.2200 |
| invoice_face_value | 3900.00 |
| dollars_recovered | 3900.00 |
| **fee_amount** | **858.00** |
| source_payment_id | `pi_3U0YL6P2aVnfVhOw1oiSutI0` |
| subscriber_id | `34205047-14e3-45bb-80e2-2fb8da2da910` |

**`recovery_links`** (row `11fdb58f…`):
- `link_status` = **paid** ✓
- `settlement_amount_cents` = **NULL** ✓ (correct for a standard link)
- `stripe_checkout_session_id` persisted ✓

**Independent reconciliation:** ledger `fee_amount` $858 == Stripe application fee `fee_1U0YLA…` (85800¢). Band math (22%) confirmed from two independent systems.

**Idempotency:** held across multiple Stripe "Resend" attempts — no duplicate ledger row.

---

## 4. Bugs found & fixed during the test

### Bug 1 — middleware bounces `/pay` to `/login` (NOT fixed — Beta blocker)
`clyintel/middleware.ts` `PUBLIC_PATHS` omits `/pay`. The pay page is designed to be public (reads via service-role off the link token, ignores auth), but middleware redirects unauthenticated visitors to `/login`, so **no real customer could ever reach the pay page.**
- **Workaround used in test:** Charles logged in first; page behaves identically.
- **Fix:** one line — add `/pay` to `PUBLIC_PATHS`. Deferred to its own PR.
- **Severity:** BETA BLOCKER — customers cannot pay until fixed.

### Bug 2 — recovery-link flip violated a check constraint (FIXED — PR #41, merged `2724822`)
`handleCheckoutCompleted.ts` step (c) wrote `settlement_amount_cents = amount_total` unconditionally. On a **standard** link that violates `recovery_links_settlement_amount_check` (column must be NULL unless `link_type='settlement'`), so the UPDATE was rejected → `flipError` → early return → **no capture, no ledger row.**
- **Fix:** select `link_type` in `resolveLink`; include `settlement_amount_cents` in the flip payload ONLY when `link_type === 'settlement'`.
- Follow-up commit `e210a60` typed the flip payload explicitly to satisfy Vercel's generated Supabase types (behavior identical).
- Unit tests missed it because they mock Supabase (the constraint only exists in a real DB).

### Root-cause chain (why the ledger stayed empty until the very end)
1. Bug 2 (constraint violation) — fixed by PR #41.
2. **`STRIPE_WEBHOOK_SECRET` was not enabled for the Production environment** in Vercel → every `POST /api/stripe-webhook` returned 500 "secret is not set." Fixed by ticking Production on the env var + redeploying (`dpl_7rjn9djMSu9rQmESGjrxfqEASxFw`).

Once both were fixed, a Stripe **Resend** of `evt_1U0YL8…` returned **200** and wrote the ledger row.

---

## 5. Operational notes / gotchas (for future tests)

- Correct webhook route is flat **`/api/stripe-webhook`** (NOT `/api/webhooks/stripe`).
- Webhook enforces `TOLERANCE_SECONDS = 5min` stale-timestamp rejection → a raw replay of an old payload 400s; **Stripe's own "Resend" re-signs with a fresh timestamp** and is the correct mechanism.
- A Vercel **redeploy re-uses the existing build** unless cache is disabled; env vars are read at build time, so confirm the new build actually picked up a changed secret.
- Repo `Phoresight-io/clyintel-app` is **PUBLIC** — `raw.githubusercontent.com` reads work unauthenticated. (Corrects an earlier handoff that said the repo was private/unreachable.)
- **NEVER** test against `charly413@gmail.com` — that is a LIVE, collection-paused account.

---

## 6. Cleanup done
- Test branch `preview/1038-capture-test` deleted (was scaffolding only — a throwaway `PREVIEW_TEST.md` commit; never merged to `main`).
- PR #41 branch already merged and consumed.

---

## 7. Backlog carried forward (out of scope for this test)

| Item | Severity |
|---|---|
| middleware `/pay` public-path fix (Bug 1) | **Beta blocker** |
| Runtime log tags `edge-middleware` though route declares `runtime="nodejs"` | Investigate |
| Settlement-link-with-no-`amount_total` latent constraint edge | Latent |
| Integration test for constraint-bearing DB writes (unit mocks hid Bug 2) | Test-coverage gap |
| Separate Supabase projects for Preview vs Production (currently shared) | Pre-Beta |

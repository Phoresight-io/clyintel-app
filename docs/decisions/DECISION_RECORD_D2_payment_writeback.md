# Decision Record D2: Payment Writeback to Accounting Systems (provider-neutral)

**Status:** DESIGN LOCKED — Phase 0 not yet prompted to Claude Code
**Depends on:** Capture bridge (✅ proven, see CAPTURE_TEST_1038_CLOSEOUT.md)
**Owner:** Charles Weldon · Product/Ops: Claude (chat) · Executor: Claude Code

---

## 1. Goal

When a recovery payment is captured (ledger row written), **reflect that payment in the
subscriber's accounting system** so their books stay correct:

1. **Mark the invoice Paid in Full** (full face value).
2. **Capture the fees for accounting** — both the Phoresight rev-share fee AND the
   Stripe processing fee — as expenses, so the subscriber's bank deposit reconciles
   to the penny.

The debtor paid the **full invoice** through the Clyintel recovery link (destination
charge to the subscriber's connected Stripe account). Stripe split it: subscriber's
payout = face − Phoresight fee − Stripe fee. The invoice is genuinely **paid in full**;
the deductions are **expenses**, not an outstanding balance. Showing a residual balance
on the invoice would wrongly imply the debtor still owes money.

**Worked example (invoice 1038):** $3,900 paid → QBO invoice marked Paid in Full ($3,900
Payment) → two expense lines booked: $858 Phoresight recovery fee + ~$113 Stripe fee.

---

## 2. Accounting model — LOCKED (Model 1 + Option B)

| Decision | Choice |
|---|---|
| Invoice status in accounting system | **Paid in Full** (write a Payment for full face value) |
| Residual balance shown on invoice | **None** — $0 outstanding |
| Fees treated as | **Expenses**, booked separately (never a balance on the invoice) |
| Fees captured | **BOTH** Phoresight rev-share fee **and** Stripe processing fee (Option B) |

**Rejected alternatives (do not re-litigate):**
- Marking only the net payout amount paid, leaving fees "outstanding" on the invoice —
  rejected: implies the debtor still owes, risks dunning the wrong party.
- Booking only the Phoresight fee, ignoring the Stripe fee — rejected: leaves the bank
  deposit gap unexplained (Option A).

---

## 3. Architecture — provider-neutral SEAM (LOCKED)

Must be **repeatable across accounting systems** (QuickBooks first; PayPal, FreshBooks,
Xero, etc. later). The webhook must NOT know about QuickBooks.

```
handleCheckoutCompleted (webhook)   ── knows nothing about any provider
        │  "capture succeeded → reflect this payment"
        ▼
reflectPayment(input)               ── neutral seam: looks up provider, dispatches
        │
        ├─ provider='quickbooks' ─► qboAdapter      (Phase 1: Payment, Phase 2: Purchase)
        ├─ provider='freshbooks' ─► freshbooksAdapter (future)
        └─ provider= …           ─► (future adapters)
```

**Neutral contract (provider-agnostic input to `reflectPayment`):**
`{ subscriberId, provider, externalInvoiceId, amountPaidCents, currency,
   capturePaymentId, ledgerRowId }`
— everything an adapter needs; nothing provider-specific leaks up to the webhook.

**Consistency with existing locked architecture:** mirrors the `capture_sources` open
registry and the `isContactAllowed` / `invoicePastDue` adapter seams — the core stays
source-agnostic; provider specifics live behind an adapter.

**Honest scope caveat:** the seam gives a clean insertion point and a shared *contract*.
It does NOT mean providers share write logic — each accounting system's "mark paid + book
fee" semantics differ (QBO Payment+Purchase objects ≠ PayPal ≠ FreshBooks). Each future
adapter is real, provider-specific work. The win is **isolation** (additive, no webhook
surgery), not code reuse. Do not expect FreshBooks to be "free."

---

## 4. Grounding findings (verified 2026-08-04 against live schema/repo)

| Finding | Detail | Consequence |
|---|---|---|
| QBO client is **read-only** | `lib/qbo/client.ts` header: "exactly two single-entity GETs"; all methods GET | Phase 0 must add a write primitive (frozen GET client stays untouched) |
| Token machinery **already exists** | `lib/qbo/tokens.ts` → `getValidAccessToken(subscriberId)` returns `{accessToken, realmId}`, refreshes within 5min of expiry, handles Intuit refresh-token rotation | Phase 0 does NOT build OAuth/refresh — it reuses this |
| Dispatch key is an **enum** | `connected_accounts.provider` is Postgres enum `integration_provider` = `stripe \| quickbooks \| twilio \| mailersend` | Seam dispatches on `provider = 'quickbooks'` (NOT `'qbo'`). Adding FreshBooks/PayPal later needs an `ALTER TYPE ... ADD VALUE` migration, not just a new file — the code is additive, the enum is a schema change |
| Test subscriber's QBO row | `connected_accounts` id `a1a7e7ee-c932-4fd0-902e-868a6bc0e6ec`, provider `quickbooks`, external_id (realmId) `9341457364281969` (SANDBOX) | Writes prove out safely in sandbox |
| QBO scope is read+write | Intuit's `com.intuit.quickbooks.accounting` scope covers both; there is no separate write scope | If the token can GET, it can POST — but PROVE it in Phase 0, don't assume |

### ⚠ PREREQUISITE BLOCKER — QBO token likely stale
Test subscriber's `token_expires_at = 2026-07-05` (access token expired ~30 days ago).
`getValidAccessToken` will attempt a refresh, but Intuit also expires the **refresh
token** after ~100 days of non-use (and rotates it each refresh). **If the refresh token
is also stale, the QBO connection must be re-authorized (reconnect via the dashboard)
before any read or write succeeds.** This is the most likely thing to block Phase 0's
proving test — resolve first.

### ⚠ Pre-Beta hardening note — refresh race
`lib/qbo/tokens.ts` deliberately omits a lock (comment: *"Do NOT add locking here yet"*,
justified for sandbox/single-user). But writeback fires inside a **webhook handler**,
which Stripe can deliver/retry concurrently. Fine for sandbox Phase 0/1; **before
production QBO writes, add the lock the comment describes** around refresh + write-back.

---

## 5. Fee amounts

| Fee | Amount (invoice 1038) | Source | Available now? |
|---|---|---|---|
| Phoresight rev-share | $858.00 | `rev_share_ledger.fee_amount` / Stripe `application_fee` | ✅ known |
| Stripe processing | ~$113 (2.9%+30¢, unconfirmed) | Charge's `balance_transaction` **on the connected account** | ❌ NOT stored; needs a new Stripe read *with connected-account context* (`acct_1Thfzc0…`). Deferred to Phase 2. Charles to obtain exact figure in Phase 2. |

---

## 6. Phased build plan

Each phase = its own Claude Code prompt + its own review/merge. Idempotency-first
throughout (a duplicate Payment write corrupts a customer's books).

### Phase 0 — Write foundation + neutral seam (NO business write)
Proves the rails before anything touches books.
- **`lib/ledgerSync/reflectPayment.ts`** — neutral seam + dispatcher. Looks up
  `connected_accounts.provider` for the subscriber, dispatches to the matching adapter.
  Unknown/unsupported provider → typed no-op refusal (never throws into the webhook).
- **`lib/qbo/writeClient.ts`** — QBO write primitive: authenticated `POST` to
  `/v3/company/{realmId}/{entity}` via `getValidAccessToken()`. (Frozen GET client
  untouched.)
- **`lib/ledgerSync/adapters/qboAdapter.ts`** — QBO adapter. **Phase 0 = proving stub:**
  authenticates + read-only round-trips (GET invoice 145) to prove token+realm reach
  sandbox. Returns `{ ok, provider:'quickbooks', probe:'read-verified' }`. **No write.**
- **Dashboard-triggerable test hook** — guarded admin route/script that calls
  `reflectPayment()` for subscriber `34205047…` against sandbox realm `9341457364281969`.
- **NOT in Phase 0:** no wiring into `handleCheckoutCompleted` (don't put a stub in the
  frozen money path); no Payment write; no fees; no Stripe read.
- **Exit criteria:** seam dispatches on real provider enum; sandbox round-trip succeeds
  (proves the scope/token question); zero writes to books.

### Phase 1 — Mark invoice Paid in Full
- Replace the qboAdapter stub body with a real **QBO Payment POST** (full face value)
  against the external invoice (txnId 145) → invoice shows Paid in Full.
- Wire `reflectPayment()` into `handleCheckoutCompleted`, immediately after the ledger
  row is written (agreed trigger point).
- **Idempotency:** dedupe on a durable key (`ledgerRowId` and/or Stripe PI) — a webhook
  retry must never post a second QBO Payment. Prove idempotency in sandbox.
- **Exit criteria:** sandbox invoice 1038 → Paid in Full; retry writes no duplicate.

### Phase 2 — Capture fees as expenses
- New Stripe read: pull the processing fee from the charge's `balance_transaction`
  **with connected-account context** (`acct_1Thfzc0…`). Charles supplies/confirms the
  exact figure.
- QBO **Purchase/Expense** write(s): $858 Phoresight recovery fee + Stripe processing fee.
- **Exit criteria:** sandbox books show both expense lines; net reconciles to the
  simulated bank deposit.

---

## 7. Guarantees held across all phases
- Frozen capture core untouched (`processCaptureEvent.ts`, `captureEvent.ts`,
  `captureDeps.ts`, `captureResult.ts`, `computeRevShareFee.ts`).
- Frozen GET-only QBO client (`lib/qbo/client.ts`) untouched — writes live in a new file.
- Sandbox realm `9341457364281969` only until explicitly promoted.
- Idempotency-first on every write path.
- One Claude Code prompt per phase; CC reports grounding → diff → stops for merge approval.
- Squash-merge to `main` via GitHub UI by Charles.

---

## 8. Open items before Phase 0 prompt
1. **Resolve the stale-token prerequisite** (Section 4) — reconnect QBO if the refresh
   token is dead. Without this, Phase 0's proving test cannot pass.
2. Confirm this spec is accepted; then Claude drafts the single Phase 0 Claude Code prompt.

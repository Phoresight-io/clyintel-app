# TEST_SPEC.md — clyintel
_Beta launch test specification_
_Created: 2026-05-27_

---

## Overview

Tests are grouped into three categories. All must pass before any real subscriber data is stored or Beta invites are sent.

**Category 1 — Schema integrity:** Tables, columns, enums, and constraints exist as specced.
**Category 2 — RLS enforcement:** Data isolation is bulletproof. This is the most critical category.
**Category 3 — Subscriber Beta flows:** Core user journeys work end-to-end.

Agent tests (SMS, email, voice) are a separate workstream — not in scope for this spec.

---

## How to run

Framework: Vitest (unit + integration) + Playwright (E2E).
Configure both before running any test in this spec.

```bash
cd clyintel
npm install --save-dev vitest @vitest/coverage-v8 playwright @playwright/test
npx playwright install chromium
```

Test files live in `clyintel/tests/`:
```
tests/
  schema/         # Category 1
  rls/            # Category 2
  flows/          # Category 3
  helpers/        # Shared test utilities
```

All tests that touch Supabase use the service role key against the `clyintel-dev` project.
Create two test subscriber records before running Category 2 — `subscriber_a` and `subscriber_b` — and clean them up after.

---

## Category 1 — Schema integrity

### 1.1 Enum values

**Test:** `billing_path` enum does not contain `payg`
```
Expected values: ['revenue_share']
Must not contain: 'payg'
```

**Test:** `plan_tier` enum contains exactly the correct values
```
Expected: ['free', 'starter', 'plus', 'pro', 'enterprise']
```

**Test:** `invoice_status` enum contains all expected values
```
Expected: ['draft', 'sent', 'partial', 'paid', 'overdue', 'in_recovery', 'written_off']
```

### 1.2 Plans seed data

**Test:** 5 plan records exist with correct tiers
```
free (tier 0) — monthly_price_cents = 0, revenue_share_rate = 0.22
starter (tier 1) — monthly_price_cents = 2900, revenue_share_rate = 0.18
plus (tier 2) — monthly_price_cents = 7900, revenue_share_rate = 0.12
pro (tier 3) — monthly_price_cents = 14900, revenue_share_rate = 0.08
enterprise (tier 4) — monthly_price_cents = 0, revenue_share_rate = 0.05
```

**Test:** Pro and Enterprise plans have `ai_sms_agent` and `ai_voice_agent` flags — if columns exist
**Test:** Free plan has `payg_available = false`

### 1.3 Foreign key constraints

**Test:** `clients.subscriber_id` FK → `subscribers.id` is enforced
- Insert a client with a non-existent subscriber_id → expect constraint violation

**Test:** `invoices.subscriber_id` FK → `subscribers.id` is enforced
**Test:** `invoices.client_id` FK → `clients.id` is enforced
**Test:** `recovery_attempts.subscriber_id` FK → `subscribers.id` is enforced
**Test:** `ptr_scores.subscriber_id` FK → `subscribers.id` is enforced
**Test:** `communications.subscriber_id` FK → `subscribers.id` is enforced

### 1.4 Generated columns

**Test:** `invoices.amount_outstanding_cents` is computed correctly
```
Insert invoice with amount_cents = 10000, amount_paid_cents = 3000
Expected: amount_outstanding_cents = 7000
```

### 1.5 Audit log table

**Test:** `audit_log` table exists with required columns
```
Required columns: id, subscriber_id, actor, action, entity_type, entity_id, payload, created_at
```

**Test:** `audit_log` created_at defaults to `now()`
**Test:** Direct insert via anon key is rejected (service role only)

---

## Category 2 — RLS enforcement

**These are the most important tests in the entire spec.**
A failing RLS test means the product is not safe to ship.

### Setup

Before each test in this category:
1. Create `subscriber_a` in `auth.users` + matching row in `subscribers`
2. Create `subscriber_b` in `auth.users` + matching row in `subscribers`
3. Create test data (clients, invoices, etc.) owned by `subscriber_a`
4. Obtain JWT tokens for both subscribers

After each test:
1. Delete all test data
2. Delete both test subscribers from `auth.users` and `subscribers`

### 2.1 Subscribers table

**Test:** Subscriber A cannot read Subscriber B's row
```
Query subscribers as subscriber_a → expect only own row
Query subscribers as subscriber_b → expect only own row
Cross-query: subscriber_a querying for subscriber_b's id → expect 0 rows
```

**Test:** Subscriber A cannot update Subscriber B's row
```
Update subscribers set business_name = 'hacked' where id = subscriber_b.id
Execute as subscriber_a → expect 0 rows updated
Verify subscriber_b's business_name is unchanged
```

**Test:** Subscriber cannot delete their own row (if delete is disallowed)

### 2.2 Clients table

**Test:** Subscriber A cannot read Subscriber B's clients
```
Insert 3 clients for subscriber_a, 2 clients for subscriber_b
Query as subscriber_a → expect exactly 3 rows
Query as subscriber_b → expect exactly 2 rows
```

**Test:** Subscriber A cannot update Subscriber B's clients
**Test:** Subscriber A cannot delete Subscriber B's clients
**Test:** Subscriber A cannot insert a client with subscriber_b's subscriber_id

### 2.3 Invoices table

**Test:** Subscriber A cannot read Subscriber B's invoices
```
Insert invoices for both subscribers
Query as subscriber_a → expect only own invoices
```

**Test:** Subscriber A cannot update Subscriber B's invoices
**Test:** `amount_outstanding_cents` is not directly writable (generated column)

### 2.4 Communications table

**Test:** Subscriber A cannot read Subscriber B's communications
**Test:** Subscriber A cannot insert a communication with subscriber_b's subscriber_id

### 2.5 Recovery attempts table

**Test:** Subscriber A cannot read Subscriber B's recovery attempts
**Test:** Subscriber A cannot insert a recovery attempt for subscriber_b's invoice

### 2.6 PTR scores table

**Test:** Subscriber A cannot read Subscriber B's ptr_scores
**Test:** Subscriber A cannot insert a ptr_score for subscriber_b's client

### 2.7 Connected accounts table

**Test:** Subscriber A cannot read Subscriber B's connected_accounts
- This is the highest-sensitivity table — OAuth tokens live here
**Test:** Subscriber A cannot update Subscriber B's connected_accounts

### 2.8 Payments and invoice_payments tables

**Test:** Subscriber A cannot read Subscriber B's payments
**Test:** Subscriber A cannot read Subscriber B's invoice_payments

### 2.9 Templates table

**Test:** All authenticated subscribers can read system default templates (`subscriber_id IS NULL`)
**Test:** Subscriber A cannot read Subscriber B's custom templates
**Test:** Subscriber A cannot update or delete Subscriber B's templates

### 2.10 Plans table

**Test:** All authenticated subscribers can read all plans (read-only reference data)
**Test:** No subscriber can insert, update, or delete plan records

### 2.11 Audit log table

**Test:** Subscriber A can read their own audit log rows
**Test:** Subscriber A cannot read Subscriber B's audit log rows
**Test:** No subscriber can insert directly into audit_log via anon key
**Test:** No subscriber can update or delete audit_log rows

### 2.12 Unauthenticated access

**Test:** Unauthenticated request to `clients` returns 0 rows (not an error — RLS silently filters)
**Test:** Unauthenticated request to `invoices` returns 0 rows
**Test:** Unauthenticated request to `subscribers` returns 0 rows

---

## Category 3 — Subscriber Beta flows

These are end-to-end flows tested with Playwright against the live Vercel deployment or local dev server.

### 3.1 Signup flow

**Test:** New user can sign up with email + password
```
1. Navigate to /login
2. Click "Sign up"
3. Enter email + password
4. Submit → expect redirect to /
5. Verify subscriber record created in Supabase with correct plan_id (Free)
6. Verify auth.users record exists
```

**Test:** New user can sign up with Google OAuth
```
1. Navigate to /login
2. Click "Continue with Google"
3. Complete Google OAuth flow
4. Expect redirect to /
5. Verify subscriber record created
```

**Test:** Duplicate email signup is rejected with clear error message

**Test:** Signup with invalid email format is rejected before submission

### 3.2 Login flow

**Test:** Existing user can log in with email + password
```
1. Navigate to /login
2. Enter credentials
3. Submit → expect redirect to /
4. Verify session cookie is set
```

**Test:** Existing user can log in with Google OAuth

**Test:** Wrong password shows error, does not log in

**Test:** Unauthenticated user accessing `/` is redirected to `/login`

**Test:** Unauthenticated user accessing `/portfolio` is redirected to `/login`

**Test:** Unauthenticated user accessing `/client/123` is redirected to `/login`

### 3.3 Session management

**Test:** Session persists across page refresh
**Test:** Logged-out user cannot access protected routes
**Test:** Sign out clears session and redirects to `/login`

### 3.4 Data isolation — UI level

**Test:** Subscriber A's dashboard shows only their own invoices
```
1. Log in as subscriber_a
2. Navigate to /
3. Verify invoice table contains only subscriber_a's invoices
4. Log out
5. Log in as subscriber_b
6. Verify invoice table contains only subscriber_b's invoices
```

**Test:** Subscriber A's portfolio shows only their own clients

**Test:** Subscriber A cannot navigate to a client owned by Subscriber B
```
1. Log in as subscriber_a
2. Navigate to /client/[subscriber_b_client_id]
3. Expect 404 or redirect — not subscriber_b's data
```

### 3.5 Stripe onboarding (subscription path)

**Test:** Free subscriber can access portal after signup (no Stripe required)

**Test:** Subscriber initiating Starter plan upgrade is redirected to Stripe Checkout
```
1. Log in as free subscriber
2. Click upgrade to Starter
3. Expect redirect to Stripe Checkout with correct price_id
```

**Test:** Successful Stripe payment updates subscriber plan in Supabase
```
1. Complete Stripe Checkout with test card
2. Verify Stripe webhook fires
3. Verify subscriber.plan_id updated to Starter plan
4. Verify subscriber.subscription_status = 'active'
```

**Test:** Failed Stripe payment does not update subscriber plan

### 3.6 Manual invoice entry

**Test:** Subscriber can add a client + invoice via manual entry
```
1. Log in
2. Navigate to /connections
3. Select Manual Entry
4. Fill form: client name, invoice #, amount, due date
5. Submit
6. Verify invoice record created in Supabase with correct subscriber_id
7. Verify client record created or matched
8. Verify invoice appears in dashboard
```

**Test:** Manual invoice is scoped to the creating subscriber only

### 3.7 Invoice display

**Test:** Dashboard KPI cards reflect correct subscriber data
```
Total Outstanding = sum of non-paid invoice amounts for this subscriber
Past Due = sum of overdue invoice amounts
Active Invoices = count of current + overdue invoices
```

**Test:** Invoice table sorts by days overdue descending by default

**Test:** Invoice search filters correctly by client name (min 3 chars)

**Test:** Exchange drawer opens for a valid invoice and shows communications history

### 3.8 Portfolio dashboard

**Test:** Portfolio table shows only the subscriber's clients
**Test:** Client score displays correctly with risk band color

### 3.9 Client detail

**Test:** PTR widget displays recommendation for a scored client
**Test:** PTR widget shows "run a score first" state for unscored clients
**Test:** Invoice history table shows paid and outstanding invoices

### 3.10 Audit log

**Test:** Every subscriber action that modifies data creates an audit_log entry
```
Actions to verify: create invoice, create client, approve negotiation rec
Each entry must have: subscriber_id, actor = 'subscriber', action, entity_type, entity_id, created_at
```

**Test:** Audit log entries are visible to the owning subscriber in their session

---

## Acceptance criteria for Beta launch

All of the following must be true before Beta invites go out:

- [ ] Category 1: All schema integrity tests pass
- [ ] Category 2: All RLS tests pass — zero cross-subscriber data leakage
- [ ] Category 3.1: Signup (email + Google OAuth) works end-to-end
- [ ] Category 3.2: Login and route protection works
- [ ] Category 3.4: UI-level data isolation confirmed for 2 test subscribers
- [ ] Category 3.5: Stripe onboarding completes and updates subscriber plan
- [ ] Category 3.6: Manual invoice entry creates scoped records
- [ ] Category 3.7–3.9: Core dashboard, portfolio, and client detail render real data
- [ ] Category 3.10: Audit log entries created for subscriber actions

Agent tests (SMS, email, voice subscriber scoping) are a post-Beta P1 — tracked separately.

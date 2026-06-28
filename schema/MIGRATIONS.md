# Migration Log

Migrations applied to `clyintel-dev` (`mhvuqjryesjsrictesuk`) via Supabase MCP.
Newest first.

| Date | Name | Summary |
|---|---|---|
| 2026-06-28 | `create_rev_share_ledger` ([sql](./create_rev_share_ledger.sql)) | `CREATE TABLE public.rev_share_ledger` — persistence layer behind the D2 accrual ledger (id, subscriber_id FK → subscribers, invoice_ref, invoice_face_value, dollars_recovered, band, rate, fee_amount, captured_at, cycle_close, engine_version, created_at; non-negative `CHECK`s on amounts, `rate` constrained to [0,1]). Indexes on `(subscriber_id, cycle_close)` and `(invoice_ref)`. RLS enabled with a **SELECT-only** `subscriber_isolation_select` policy (`subscriber_id = auth.uid()`) — intentionally NOT cmd ALL: subscribers read their own rows, writes flow only through the service role (detection job). Table ships empty; D2 BillingTab stays on mock data. Security advisor: no new findings. |
| 2026-06-19 | `add_payments_stripe_event_id_unique` ([sql](./add_payments_stripe_event_id_unique.sql)) | `ALTER TABLE public.payments ADD CONSTRAINT payments_stripe_event_id_key UNIQUE (stripe_event_id);` — DB-enforced idempotency for subscription payment capture (one payments row per Stripe event). NULLs stay distinct, column stays nullable. Table empty at apply time. Constraint was already present in clyintel-dev; the committed SQL is replay-safe (adds only if missing). No type change (UNIQUE constraints don't surface in generated types). |
| 2026-06-19 | `add_refunded_amount_cents_to_payments` | `ALTER TABLE public.payments ADD COLUMN refunded_amount_cents bigint NULL;` — cumulative refunded amount (cents); NULL = never refunded. Full-vs-partial derived as `refunded_amount_cents` vs `amount_cents` (no new enum value). Populated by the refund handler in a later prompt. Types regenerated into `clyintel/types/supabase.ts`. |

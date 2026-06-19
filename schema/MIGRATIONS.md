# Migration Log

Migrations applied to `clyintel-dev` (`mhvuqjryesjsrictesuk`) via Supabase MCP.
Newest first.

| Date | Name | Summary |
|---|---|---|
| 2026-06-19 | `add_refunded_amount_cents_to_payments` | `ALTER TABLE public.payments ADD COLUMN refunded_amount_cents bigint NULL;` — cumulative refunded amount (cents); NULL = never refunded. Full-vs-partial derived as `refunded_amount_cents` vs `amount_cents` (no new enum value). Populated by the refund handler in a later prompt. Types regenerated into `clyintel/types/supabase.ts`. |

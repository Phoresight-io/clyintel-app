-- Migration: add_rev_share_ledger_invoice_number
-- NOT YET APPLIED — deliver for review; Charles applies to clyintel-dev.
--
-- Adds the human invoice number to the rev-share ledger so a captured row is
-- QBO-reconcilable by BOTH identifiers: source_invoice_id (the QBO txnId, e.g.
-- '145') and invoice_number (the human number, e.g. '1038'). Nullable so it does
-- not break the existing QBO worker capture path, which leaves it unset — only
-- the Stripe recovery path (PR 2a deps enrichment, gated on source =
-- 'stripe_recovery') populates it.

ALTER TABLE public.rev_share_ledger
  ADD COLUMN invoice_number text;

-- Seed: seed_capture_source_stripe_recovery
-- NOT YET APPLIED — deliver for review; Charles applies to clyintel-dev.
--
-- Registers the Stripe recovery-payment capture source so the recovery webhook
-- (PR 2b) can build a CaptureEvent with source = 'stripe_recovery' that passes
-- the core's getSource() registry check and satisfies the rev_share_ledger.source
-- FK (references capture_sources(id)). Idempotent: ON CONFLICT DO NOTHING leaves
-- any existing row untouched. Does NOT alter the 'qbo' row.

INSERT INTO capture_sources (id, display_name, kind, active)
VALUES ('stripe_recovery', 'Stripe Recovery', 'native_adapter', true)
ON CONFLICT (id) DO NOTHING;

-- Seed: seed_capture_source_qbo
-- Applied to clyintel-dev (mhvuqjryesjsrictesuk) via Supabase MCP, 2026-07-01.
--
-- Registers the QuickBooks Online capture source so the webhook worker can
-- route inbound events on source = 'qbo'. Idempotent: ON CONFLICT DO NOTHING
-- leaves any existing row (e.g. from capture_detection_phase1) untouched.

INSERT INTO capture_sources (id, display_name, kind, active)
VALUES ('qbo', 'QuickBooks Online', 'native_adapter', true)
ON CONFLICT (id) DO NOTHING;

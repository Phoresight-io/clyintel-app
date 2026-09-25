-- Client Score v0 — explanation columns on ptr_scores.
--
-- NOT APPLIED by the PR that adds it. Apply via Supabase MCP after verifying the
-- live constraints below.
--
-- score_summary / score_factors / risk_drivers hold the deterministic, data-backed
-- text lines the Client Score rail renders (lib/score/computeClientScore.ts).
-- inputs holds the audit trail: raw aggregates, each component value, and the
-- weights used.
--
-- Upsert key: the scorer upserts onConflict (client_id, score_month). Live check
-- (2026-09-25) showed a unique index already covers it:
--   CREATE UNIQUE INDEX idx_ptr_scores_client_month ON public.ptr_scores (client_id, score_month)
-- so this file does NOT create the spec's `ptr_scores_client_month_uniq`. That
-- index would only duplicate the existing one. Also live: score_month is TEXT
-- 'YYYY-MM', and trigger trg_ptr_score_month (set_ptr_score_month) always sets it
-- from score_date on INSERT/UPDATE.
--
-- Guard: if the existing index is ever dropped, recreate it under the same name
-- so the upsert keeps its conflict target.

alter table public.ptr_scores
  add column if not exists score_summary text[],
  add column if not exists score_factors text[],
  add column if not exists risk_drivers  text[],
  add column if not exists inputs        jsonb;

create unique index if not exists idx_ptr_scores_client_month
  on public.ptr_scores (client_id, score_month);

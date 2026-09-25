# Client Score v0: handoff

_Branch `feat/client-score-v0` · off `main` @ 4f54965 · 2026-09-25_

## Root cause

The Client Score rail in `components/detail/DetailScreen.tsx` (Score, Score Summary,
Score Factors, Risk Drivers) showed `0` / "High risk" / empty lists for every real
client. Nothing in the codebase wrote `ptr_scores`, which had 0 rows (re-checked
live 2026-09-25). `toUIClient` then made up a `0` (`composite_score ?? 0`), set
`prevScore = score`, and hardcoded `scoreFactors = []`. The rich card used to render
hardcoded mock data, which was flushed on purpose in PR #30 (3821451).

## Design

| Piece | File | Notes |
|---|---|---|
| Pure scorer | `lib/score/computeClientScore.ts` | No I/O, no clock reads (`asOf` is passed in), no LLM. Deterministic. |
| Loader | `lib/score/loadScoreInputs.ts` | Service-role reads, each filtered by `subscriber_id` + `client_id`. Paid timing = `invoice_payments → payments.paid_at`, `status='succeeded'` only. Prior = latest row from an earlier `score_month`. |
| Route core + port | `lib/score/scoreClient.ts` | Ownership gate → compute → dry-run or upsert. Same shape as `lib/contacts/mutateContact.ts`. |
| Route | `app/api/clients/[id]/score/route.ts` | Session auth (401). GET = dry run, writes nothing. POST = upsert `onConflict: "client_id,score_month"`. Unowned client or non-UUID id → 404. `insufficient_data` → 422, no write. Scores one client only. |
| Read path | `lib/data.ts` `getPtrScores` → `{ latest, prior }` (limit 2); `lib/adapters.ts` `toUIClient` | `score` / `prevScore` are `number \| null`, never a made-up 0. Lists come from the new array columns (`?? []`). |
| UI | `DetailScreen`, `ClientListScreen`, `PTRWidget` | Unscored clients show "Not yet scored" plus a "Score this client" button (POST, then `router.refresh()`). Scored clients show a "Rescore" button. The ▲/▼ delta is hidden when there is no prior score. Lists and widgets show "—" in a neutral color. |

Past-due status reuses `uiStatus()` / `daysFromToday()` from `lib/adapters.ts`. They
are now exported and take an injectable `now`; the default is unchanged. This keeps
the score in agreement with what the page shows.

### Components and weights

| Component | Weight | Definition | Null when |
|---|---|---|---|
| paymentHistory | .40 | On-time rate over paid invoices with a known `paid_at` (last succeeded payment `::date` ≤ `due_date`). `written_off` counts as paid late. | No paid invoice has timing and nothing is written off |
| currentDelinquency | .30 | Max days past due: 0→100, 1–15→80, 16–30→60, 31–60→35, 61–90→15, >90→0 | never (once there are non-draft invoices) |
| exposure | .15 | `100 × (1 − pastDueOutstanding / totalBilledNonDraft)`, clamped 0–100 | total billed = 0 |
| responsiveness | .15 | Replied outbound ÷ outbound. A reply is `reply_received_at` set, or an inbound row on the same invoice. | No outbound comms |

Composite = `round(weighted mean over the non-null components)`, with the weights
renormalized to sum to 1. Risk bands: ≥80 low, 60–79 medium, 40–59 high,
<40 critical. `inputs` jsonb stores the raw aggregates, each component, the base
weights and the renormalized weights.

The text lists come from fixed templates. A line appears only when its data exists:
summary has 2–4 lines, factors 2–4, drivers 1–3 (or "No material risk drivers
identified"). The upsert leaves out `ai_model`, `ai_recommendation`,
`ai_recommendation_at` and `counted_toward_limit`, so a re-score never overwrites
them.

## Where the live schema differs from the spec (checked read-only 2026-09-25)

- `score_month` is **text `'YYYY-MM'`**, not a date. Trigger `trg_ptr_score_month`
  (`set_ptr_score_month`) always sets it to `TO_CHAR(score_date,'YYYY-MM')` on
  INSERT/UPDATE. The scorer emits the same format.
- **A unique index `idx_ptr_scores_client_month (client_id, score_month)` already
  exists.** The migration does not create the spec's `ptr_scores_client_month_uniq`,
  which would only duplicate it. Its `create unique index if not exists` uses the
  existing name, so on the live DB it does nothing.
- Numeric scales: `composite_score` / `payment_history_score` numeric(5,2),
  `avg_days_overdue` numeric(6,2) (the scorer caps it at 9999.99),
  `non_response_rate` numeric(5,4). The scorer rounds to these scales.

## Current state: nothing applied or written yet

- Migration `schema/add_score_explanations_to_ptr_scores.sql` is **NOT applied**.
- The endpoint has **not** been called against live data. `ptr_scores` = 0 rows.
- Until the migration is applied, a POST fails with a 500 (the new columns are
  missing). GET (dry run) works.

Apply order: 1) apply the migration via MCP, 2) check the columns exist and the
unique index is still there, 3) merge/deploy, 4) GET dry-run one client, 5) POST.

## Follow-ups

- **Agent-2 AI summary line**: an LLM line written to `ai_recommendation` /
  `ai_model`, shown alongside the deterministic summary. The v0 upsert already
  leaves those columns alone.
- **Recovery Recommendations source**: `negotiationRecs = []` in DetailScreen still
  has no data source. Out of scope here.
- **Due-date convention**: `daysFromToday` uses `Math.round` against the current
  time, so `due_date == today` is inconsistent. The scorer inherits the UI
  convention on purpose. Fix both together.
- **written_off is double-counted**: it counts as late in paymentHistory AND as
  past_due via uiStatus, so it also feeds delinquency and exposure, and the
  "Oldest open invoice" driver can cite it. QBO has no written_off status, so this
  can't happen with today's data. Fix it before any non-QBO invoice source goes live.
- Batch / scheduled scoring (all clients, monthly) and `counted_toward_limit`
  accounting.
- `dispute_rate` has no source (it stays null).

# Client Score v0 → v1: handoff

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

### Scoring logic: v1 (replaces the v0 scoring; route, auth, UI null state unchanged)

The shared constants live in `lib/score/scoreBands.ts`, used by both the scorer and the UI:
- `latenessScore(days)`: ≤0→100 · 1–7→90 · 8–15→80 · 16–30→65 · 31–45→50 ·
  46–60→35 · 61–75→25 · 76–90→15 · 91–105→10 · 106–120→5 · >120→0
- `bandFor(score)`: ≥85 low · ≥70 medium · ≥55 high · else critical. Labels:
  Low / Moderate / High / Severe risk. Colors: green / amber / orange / red
  (`C.orange` added to `lib/theme.ts`).
- `PRIOR = 70`, `PROVISIONAL_MIN_DATED = 3`, and
  `WEIGHTS = { paymentHistory: .55, currentDelinquency: .30, exposure: .15 }`.

**Payment dates don't depend on their source.** `lib/score/resolvePaidTimings.ts`
turns each paid invoice's evidence into ONE `{ invoice_id, paid_date, date_source }`
record, using this precedence:
1. The last succeeded payment (`payments.paid_at` via `invoice_payments`) → `payment`.
2. Otherwise, the first `balance_events` row with `new_outstanding_cents = 0`
   (ordered by `detected_at`): `evidence.txnDate` → `qbo_txn`, or else
   `detected_at` → `detected`.
3. Otherwise there is no record, and the invoice counts as "paid, undated".

The scorer never branches on `date_source`; it only records it in `inputs`.
Communications are no longer loaded (responsiveness is v2).

| Component | Weight | Definition |
|---|---|---|
| paymentHistory | .55 | Amount-weighted mean of `latenessScore(paid_date − due_date)` over dated paid invoices, with `written_off` scoring 0. `n` = dated paid + written_off. History = `(n·mean + 70)/(n+1)`; `n = 0` → 70. Paid invoices with no due_date are excluded (counted in `no_due_date_count`). |
| currentDelinquency | .30 | `latenessScore(max days past due)` over open past-due invoices (uiStatus/daysFromToday), **excluding written_off**. None past due → 100. |
| exposure | .15 | `100 × (1 − pastDueOutstanding / totalBilledNonDraft)`, clamped. written_off is **excluded** from pastDueOutstanding. |

- composite = `round(Σ w·c)`, with no renormalization; risk_level = `bandFor(composite)`.
- provisional = `n < 3`. It is stored in `inputs.provisional`, and the rail shows a
  "Provisional" badge.
- `insufficient_data` (422, no write) when there are no non-draft invoices or
  total billed = 0.

The text lines only describe real data: the 70 prior is never cited. With zero
dated payments the headline is timing-neutral, and the history driver requires n > 0.

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

## Current state

- Per Charles, the explanation columns (`score_summary`, `score_factors`,
  `risk_drivers`, `inputs`) are already live on Test. The migration file stays as
  the record of that change; no further migration is needed for v1.
- The endpoint has **not** been called against live data from this branch.
- PR base is `develop` (feature PRs → develop; develop → main is a separate release PR).

## Follow-ups

- **Agent-2 AI summary line**: an LLM line written to `ai_recommendation` /
  `ai_model`, shown alongside the deterministic summary. The v0 upsert already
  leaves those columns alone.
- **Recovery Recommendations source**: `negotiationRecs = []` in DetailScreen still
  has no data source. Out of scope here.
- **Due-date convention**: `daysFromToday` uses `Math.round` against the current
  time, so `due_date == today` is inconsistent. The scorer inherits the UI
  convention on purpose. Fix both together.
- ~~**written_off is double-counted**~~: **fixed in v1.** written_off now counts
  only in paymentHistory (scores 0). It is excluded from delinquency, from
  exposure's pastDueOutstanding, and from the "Oldest open invoice" driver. It is
  still `past_due` in the UI's `uiStatus`; that UI convention is unchanged.
- **Responsiveness (v2)**: reply rate over outreach. It was removed from v1
  inputs and `non_response_rate` stays null.
- **Historical backfill**: add a loader source that emits the same `PaidTiming`
  records (a new `date_source` value). The scorer needs no change.
- Batch / scheduled scoring (all clients, monthly) and `counted_toward_limit`
  accounting.
- `dispute_rate` has no source (it stays null).

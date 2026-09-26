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
   (ordered by `detected_at`): `evidence.txnDate` → `qbo_txn` (speculative, see
   follow-up 2), or else
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

## Polish + auto-populate (feat/client-score-polish)

No change to the scoring math. The changes are to wording, display and when scoring runs:
- **Headline**: timing headlines ("Reliable payer", "Usually pays, sometimes
  late", "Frequently pays late") now need >= 3 dated payments. Below that the
  timing-neutral set is used, and the evidence stays visible in the "X of N dated
  payments" factor.
- **"Average delay" factor**: now uses paid-late invoices only, and is omitted
  when none were paid late. The `avg_days_overdue` column keeps its blended
  definition.
- **Paid-date column**: shows the normalized paid date from
  `lib/score/loadPaidTimings.ts`, the same reader the scorer uses, or "—". It no
  longer shows `updated_at`, which is the QBO sync touch time.
- **Auto-populate**: `ensureCurrentScore` (core in
  `lib/score/ensureCurrentScore.ts`, wiring in `lib/data.ts`) runs on the client
  page and, sequentially, in the portfolio list loader. It scores a client when
  the client has >= 1 non-draft invoice and no ptr_scores row for the current UTC
  month. It never throws or blocks the render. The first portfolio load is the
  approved one-time backfill on Test. The "Score this client" button is gone;
  "Rescore" stays.

## Freshness: daily refresh + scorer version (feat/client-score-freshness)

- **`SCORER_VERSION`** (`lib/score/scoreBands.ts`, currently `"v1.1"`) is the
  single source of truth. The scorer stamps it into `ptr_scores.inputs.version`
  on every score and in the GET dry-run. **Rule: bump it on any change to the
  scorer's logic or wording.** Every stored score then refreshes on its next
  page load.
- **When a stored score is stale** (`isScoreStale` in
  `lib/score/ensureCurrentScore.ts`):
  `!latest || latest.score_date !== today (UTC) || latest.inputs.version !== SCORER_VERSION`.
  Rows with no version count as stale, so every pre-v1.1 row is rescored once.
  Daily rescoring upserts the same `(client_id, score_month)` row, so each
  month keeps its last score. The flow is still fail-soft and sequential in the
  portfolio loader.
- **Day math**: see follow-up 3. Against the 19 Test clients scored on
  2026-09-25, the only composite that changes is Rondonuwu Fruit and Vegi,
  42 → 43. Its oldest invoice goes from 91 to 90 days past due, which crosses
  the 90/91 lateness boundary (10 → 15). Regression fixture:
  `lib/score/__fixtures__/testClients-2026-09-25.json`.

## Follow-ups

1. **Historical payment-date backfill in the QBO import**: a PREREQUISITE for
   customer launch. Today only payments detected since go-live have dates. The
   backfill should emit the same `PaidTiming` records (a new `date_source`), so
   the scorer needs no change.
2. **Persist the QBO Payment TxnDate**, keyed by QBO payment id and updated on
   Payment Update webhooks. This replaces the speculative `evidence.txnDate`
   read in `resolvePaidTimings`. Motivating example: Geeta Kalapatapu's score
   uses `detected_at` (9/14) rather than the real payment date.
3. ~~**daysFromToday rounding**~~: **DONE (feat/client-score-freshness).** Every
   day count now goes through `daysBetweenUtcDates` (`lib/score/dates.ts`), the
   whole-day difference between UTC calendar dates, with no rounding: the scorer,
   `uiStatus`, the "Due In" column and the client list's days overdue. Due
   2026-06-28 at 2026-09-25T21:00Z is 89, not 90. An invoice due today is no
   longer shown as past due in the afternoon.
4. **Auto-rescore triggers**: rescore on payment detected, on an invoice sync
   change, nightly for past-due clients, and before outreach. *Partly done:* the
   page-load refresh is now **daily** (stale when `score_date` ≠ today UTC)
   instead of monthly. The event/nightly triggers are still open.
5. **De minimis past-due threshold** ($25 / 2%): considered, not adopted.
6. **Recency weighting** of payment history.
7. **Responsiveness (v2)**: reply rate over outreach. `non_response_rate` stays null.

Also still open:
- **Agent-2 AI summary line** → `ai_recommendation` / `ai_model`. The upsert
  already leaves those columns alone.
- **Recovery Recommendations source** (`negotiationRecs = []`).
- `counted_toward_limit` accounting; `dispute_rate` has no source.
- ~~written_off double-count~~: fixed in v1. It counts only in history; it is
  still `past_due` in the UI's `uiStatus`.

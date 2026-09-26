# Voice → email handoff: handoff

> **Post-call trigger RETIRED.** The end-of-call-report trigger described below was
> removed in "refactor(voice): remove post-call email trigger (agent-owned send
> supersedes #140)". `/api/voice/webhook` no longer sends email for any event. The
> Recovery Agent now decides and sends the payment-link email itself, mid-call, via
> an in-call Vapi tool (see the voice-tools handoff, added with that tool).
>
> **Retained and reused by the tool path:** the `handoff_email_status` claim
> (`createHandoffPort`: `claimOrRecord` NULL-guard, `finalize` guarded on
> `'claimed'`), `parseHandoffMode`, the `add_voice_calls_handoff_email` migration,
> and the `VOICE_HANDOFF_EMAIL_MODE` / `VOICE_HANDOFF_EMAIL_CLIENT_ID` fences. The
> `payment_committed` fix stays in the webhook.
>
> The rest of this document is kept as the record of the #140 design. Its trigger
> point, send conditions (`not_connected`, `no_payment_link_consent`) and runbook
> steps 4–7 no longer apply.

_Branch `feat/voice-email-handoff` · off `develop` @ 1c1e383 · 2026-09-25_

After a Vapi call where the person agrees to pay or asks for a link, send the
client **at most one** payment-link email through the existing dunning email path.
It is **off by default**: merging changes nothing until `VOICE_HANDOFF_EMAIL_MODE`
is set. This un-parks voice (cut from launch on Sep 14) on `develop`/Test only.
Prod stays off.

## Grounding (confirmed by chat on Test + develop, re-verified on the branch)

1. **Endpoint** `app/api/voice/webhook/route.ts`:
   - Verifies `x-vapi-secret`.
   - Resolves `voice_calls` (`metadata.voiceCallId` → `id`, else `call.id` → `vapi_call_id`).
   - Writes an audit row to `voice_call_events`.
   - On `end-of-call-report`, patches status, outcome (`deriveOutcome`), transcript, cost and so on.
   - After auth it always returns 200, even on internal errors, so Vapi never retries. Duplicate deliveries are still possible.
2. **`deriveOutcome()` is a catch-all.** Anything that isn't voicemail, no-answer, busy or failed becomes `'connected'`, so it isn't enough on its own as a send trigger.
3. **No structured-data plan yet.** The assistant has none, so every real report on Test has `analysis = {}`. There was also a bug: `payment_committed` was set `true` for any non-null `paymentCommitted`, including `false`. **Fixed here.**
4. **Email path** is `sendEmailStep({subscriberId, clientId, invoiceId}, 'dry_run'|'live')` in `lib/outreach/sendEmailStep.ts`.
   - It owns recipient selection, the opt-out gate, the system-default template, the payment-link gate (client → subscriber), the pre-send communications row, MailerSend and the recovery_attempts row.
   - It can throw on DB errors. It is reused as-is.
5. **`invoiceId` is required** by `sendEmailStep`, but every call placed so far has `voice_calls.invoice_id = NULL`.
6. **No link between a call and its email** existed before this change.

## Design

**Trigger point.** In the webhook, only for `end-of-call-report`, and only after the
`voice_calls` patch returns no error and exactly 1 row. The route then calls
`maybeSendVoiceHandoffEmail()` (`lib/voice/handoffEmail.ts`):
- inline, not in the background;
- inside its own try/catch, so a throw never changes the patch or the 200.

**Mode fence (fail closed).** `VOICE_HANDOFF_EMAIL_MODE` must be exactly `dry_run`
or `live`. Anything else (unset, empty, `LIVE`, garbage) means **OFF**: no claim and
no write. `VOICE_HANDOFF_EMAIL_CLIENT_ID`, if set, limits sends to that one client.

**Send conditions,** checked in order. The first one that fails records a skip with its reason:

| Check | Skip reason |
|---|---|
| Persisted `voice_calls.outcome === 'connected'` | `not_connected` |
| `analysis.structuredData.sendPaymentLink === true` (strict boolean) | `no_payment_link_consent` |
| `voice_calls.invoice_id` is set (no guessing an invoice) | `no_invoice` |
| That invoice's `amount_outstanding_cents > 0` | `invoice_not_open` |
| Client fence unset, or equal to the call's `client_id` | `client_fenced` |
| `sendEmailStep` gates | `no_primary_contact` · `channel_denied` · `no_template` · `no_payment_link` |

**At most once, enforced in the database.**
- The only way to act on a call is a conditional transition from NULL:
  `update … set handoff_email_status = 'claimed' where id = ? and handoff_email_status is null`.
  If that updates 0 rows, another delivery owns the call and nothing is sent.
- Skips use the same NULL-guarded write (→ `skipped` + reason), so a replayed delivery can never send later.
- After a successful claim, `sendEmailStep` runs and then `finalize` (guarded on `= 'claimed'`) sets:
  - `sent` or `would_send`, with the communication id;
  - `skipped`, with the gate reason;
  - `failed`, with `send_failed` or the thrown message (truncated to 500 characters).
- **`failed` is terminal.** A stuck `claimed` is never re-claimed, so nothing retries automatically.

### Status values (`voice_calls.handoff_email_status`)

| Value | Meaning |
|---|---|
| NULL | Not evaluated: mode was off, or the call pre-dates this change |
| `claimed` | Being sent. If it stays here, `sendEmailStep`/finalize crashed mid-way; check the communications row by hand |
| `would_send` | Dry run: communications row written, MailerSend not called |
| `sent` | Live send. `handoff_email_communication_id` points at the communications row |
| `skipped` | See `handoff_email_reason` |
| `failed` | Terminal. `send_failed` or the thrown error |

## Schema

`clyintel/schema/add_voice_calls_handoff_email.sql` is **not applied** by this PR; its
log entry is in `schema/MIGRATIONS.md`. It adds four nullable columns, the status
CHECK and an FK to `communications`. Types are hand-patched.

Deploy order is safe: with the mode off, nothing reads or writes the new columns,
so merging before the migration is applied changes nothing.

## Environment variables

There is no `env-matrix.md` in the repo, so the rows are recorded here:

| Var | Test | Prod | Meaning |
|---|---|---|---|
| `VOICE_HANDOFF_EMAIL_MODE` | `dry_run`, then `live` for the end-to-end test | **unset (off)** | Exactly `dry_run` or `live` enables the handoff; anything else is off |
| `VOICE_HANDOFF_EMAIL_CLIENT_ID` | `9e38c5f4-0d88-41c6-a968-394b9202f440` (0969 Ocean View Road: its dunning contact is Charles's inbox) | unset | Optional fence: only this client gets a handoff email |

## End-to-end runbook (after merge)

1. **Migration.** Chat applies `add_voice_calls_handoff_email` to Test via `apply_migration` and reads back the 4 columns, the CHECK and the FK.
2. **Vapi setup.**
   - _(Removed: the `sendPaymentLink` `structuredDataPlan` step. Nothing reads it now that the post-call trigger is gone.)_
   - Point the server URL at `https://dev-clyintel.vercel.app/api/voice/webhook`, using the Test `VAPI_WEBHOOK_SECRET`.
3. **Env.** In the Test project set `VOICE_HANDOFF_EMAIL_MODE=dry_run` and `VOICE_HANDOFF_EMAIL_CLIENT_ID=9e38c5f4…`, then redeploy.
4. **Dry run.** Place a call with `test: true`, `clientId` = 0969 Ocean View Road, its open past-due `invoiceId` and your phone as `toNumber`. Agree to pay. Verify `handoff_email_status = 'would_send'`, `to_address` is your inbox, and the link is the subscriber default.
5. **Live.** Set `VOICE_HANDOFF_EMAIL_MODE=live` and place a second call. Expect exactly one `sent` row and one email.
6. **Replay.** Re-POST that call's stored end-of-call-report from `voice_call_events` to the Test webhook. Expect `duplicate`: still exactly one email.
7. **Decline.** Place one call where you decline. Expect `skipped` / `no_payment_link_consent`.

## Known gaps (not in this PR)

- The handoff uses the validated system-default dunning template as-is. Its copy doesn't mention the call, and the send counts toward the cadence cap. A call-specific template belongs in the email fine-tune pass.
- 12 `voice_calls` rows from Sep 12 are stuck at `ringing`, with no way to reconcile them.
- Vapi's call summary is empty on every call.
- A handoff email and a same-day cadence email can both reach the same client (Agent 2 territory).
- `/api/voice/call` requires a login but takes `subscriberId` from the request body, so any logged-in user could act for another subscriber. Same pre-Beta gap as the outreach run endpoint.

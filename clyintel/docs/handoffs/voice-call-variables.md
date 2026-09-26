# Voice call variables + honest agent script: handoff

_Branch `feat/voice-call-variables` · off `develop` @ 9b70ea2 · 2026-09-25_

## What this fixes

`/api/voice/call` used to pass `assistantOverrides.variableValues` straight from
the request body, defaulting to `{}`. Callers rarely sent `variables`, so the
assistant's `{{tokens}}` rendered **empty**. The agent then improvised: it spoke
token names aloud and made details up ("Boston Tech Week").

The route now **builds the variables server-side from the DB by id**
(`lib/voice/buildCallVariables.ts`). A caller that sends only
`subscriberId` / `clientId` / `invoiceId` / `toNumber` gets a grounded agent.

- `body.variables`, when sent, is merged **over** the built set. An explicit
  caller value wins, so tests and manual calls can still force values.
- A build failure never blocks the call: it's logged, and the call goes out with
  `body.variables` alone (or `{}`).
- Missing data never throws. A missing invoice or contact leaves those keys empty.

## Variable keys (default set)

| Key | Source / format | Missing |
|---|---|---|
| `contact_name` | Voice contact (`selectForChannel` with a voice descriptor: dunning `voice_rank` → poc, has a phone, not opted out of voice). Falls back to the email contact, then the client name, then `"there"` | `"there"` |
| `client_name` | `clients.name` | `""` |
| `invoice_number` | `invoices.invoice_number` | `""` |
| `amount_due` | `"$" + (amount_outstanding_cents / 100).toFixed(2)`, e.g. `$270.00` | `""` |
| `due_date` | Human date, e.g. `June 28, 2026` (deterministic, no locale formatting) | `""` |
| `days_past_due` | Whole UTC calendar days past the due date, never negative (the same `daysBetweenUtcDates` the score uses) | `""` |
| `subscriber_name` | `business_name`, else `contact_name`, else `"our team"` | `"our team"` |
| `payment_channel` | Always `"email"` | — |

Reads use the same columns `sendEmailStep` renders from. Invoice, client and
subscriber reads are filtered by `subscriber_id`. Contacts are read only for a
client that belongs to that subscriber.

## ⚠️ Assistant tokens must match these keys exactly

The Vapi assistant's `{{token}}` names are **not in the repo**. A token that
doesn't match a key above renders empty, which is the original bug. Either:
- rename the assistant's tokens to these keys, or
- send Charles's exact token names and they'll be added as aliases in
  `callVariablesFrom`.

**Charles's actual tokens:** _not yet supplied._

## Assistant prompt edits (Vapi dashboard, not code)

The transcript shows the agent offering SMS and saying it "can't send emails
from this line." That comes from the **system prompt**, not the code. Edit the
assistant's system prompt so that it:
- **promises the email:** "I'll have a payment link emailed to you now." The
  email is sent server-side by the webhook after the call (#140); the agent only
  needs to secure agreement;
- **never offers SMS**;
- **never says it can't email** or send links.

## Still needed before the email actually goes out (not in this PR)

- The Vapi **`structuredDataPlan`** with `sendPaymentLink` must be published on
  the assistant (see `voice-email-handoff.md`).
- **`VOICE_HANDOFF_EMAIL_MODE`** must be `live` on Test (currently `dry_run` or unset).

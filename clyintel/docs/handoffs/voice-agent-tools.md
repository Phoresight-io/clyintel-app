# Voice agent tools: `get_account` + `send_payment_email`

_Branch `feat/voice-agent-tools` · off `develop` @ 53caec3 (#142) · 2026-09-26_

The Recovery Agent is an AI employee. On the call it confirms who it is speaking to. Only when the caller **asks** to be emailed does it do three things:
- offer the on-file email;
- **read the address back** to confirm it, or take a new spoken address and read that back;
- send the payment link with a tool, mid-call.

The **agent** decides whether to send and to whom. The system guarantees only record integrity:
- the link is always the real one from the DB;
- opt-outs are honored;
- at most one email goes out per call.

This replaces #140's post-call trigger, which #142 removed.

## Vapi tool contract

This was grounded from the `@vapi-ai/server-sdk` 2.0.1 types. The docs site is not reachable from the build sandbox.

**Request.** Vapi POSTs this to the tool's `server.url`:
```jsonc
{ "message": {
    "type": "tool-calls",
    "toolCallList": [ { "id": "call_abc", "type": "function",
                        "function": { "name": "send_payment_email", "arguments": "{\"email\":\"ap@acme.com\"}" } } ],
    "call": { "id": "<vapi call id>", "metadata": { "voiceCallId": "<voice_calls.id>" } }
    /* + toolWithToolCallList, artifact, assistant, customer, timestamp */ } }
```
- The SDK types `arguments` as a JSON **string**. The route also accepts an object.
- The call is resolved like the webhook resolves it: `metadata.voiceCallId`, else `call.id` → `vapi_call_id` (`lib/voice/resolveVoiceCall.ts`).

**Response.** Always HTTP 200:
```json
{ "results": [ { "toolCallId": "call_abc", "name": "send_payment_email", "result": "sent to ap@acme.com. Tell the caller to check their inbox." } ] }
```
- `result` is added to the conversation, and the model speaks from it. Use `error` instead of `result` for something the agent should act on.
- Tools are synchronous (`async: false`, the default), so the agent can say "sent — check your inbox".
- Vapi's default timeout is 20 seconds, and it does not retry.

**Auth.** Each tool's server config sends the header `x-vapi-secret: <VAPI_WEBHOOK_SECRET>`.
- The route checks it exactly like `/api/voice/webhook`: 500 if unset, 401 on mismatch.
- `/api/voice/tools` is in `WEBHOOK_PATHS` in `middleware.ts`, so it skips the session-login redirect.
- The tool's `server.url` **must** be set. Otherwise Vapi falls back to the assistant's server URL (the webhook), which returns no result.

Every request writes one `voice_call_events` audit row. It holds the raw payload, including any spoken address.

## `get_account`

- **Arguments:** none. The account is resolved from the call.
- **Result:** a JSON string. It **never** contains the payment link.

```jsonc
{ "client_name": "Acme",
  "invoice": { "number": "1036", "amount_due": "$270.00", "due_date": "June 28, 2026" },
  "contacts": [ { "contact_id": "…", "name": "Ada", "role": "AP", "contact_type": "dunning",
                  "email": "ap@acme.com", "emailable": true } ],
  "default_contact_id": "…",          // the cadence's pick (dunning rank-1 → poc)
  "payment_email_status": null }      // voice_calls.handoff_email_status: null = nothing sent on this call yet
```

- Emails are returned **in full**, because the agent reads them back to confirm.
- `emailable` is true only when all three hold: the contact has an email, `contact.opt_out_email` is false, and `clients.opt_out_email` is false.
- Voice opt-out is not consulted, because this is the email channel.
- Client and invoice reads are scoped to the call's subscriber (`lib/voice/accountView.ts`).

## `send_payment_email`

- **Arguments:** `{ email?, contact_id? }`.
- **Target priority:** spoken `email`, then `contact_id`, then the default emailable contact. The default is passed as an explicit `contactId`, so the client-level opt-out applies to it too.
- The link is always resolved from the DB inside `sendEmailStep` (client, then subscriber). It is never supplied by the agent and never spoken.
- The orchestrator is `lib/voice/sendPaymentEmailForCall.ts`.

It runs these steps in order:
1. **Mode fence.** If `VOICE_HANDOFF_EMAIL_MODE` is not exactly `dry_run` or `live`, it writes nothing and tells the agent email isn't available.
2. **Record checks (read-only).**
   - `no_call`
   - `no_invoice`
   - `invoice_not_open`: `amount_outstanding_cents` ≤ 0
   - `client_fenced`: `VOICE_HANDOFF_EMAIL_CLIENT_ID` is set and differs from the call's client.
3. **Already handled on this call?** A read-only check of the claim state. If there is one, the result is `already_sent …`.
4. **Target checks (read-only, before the claim).** Any of these returns an `error` with **no DB write**, so the agent can ask again on the same call:
   - invalid email syntax;
   - contact not on this client;
   - contact has no email;
   - the contact is opted out, or the client is (`clients.opt_out_email`).

   These use the same pure helpers and `isChannelAllowed` gate that `sendEmailStep` runs again.
5. **Claim** `voice_calls.handoff_email_status` with a transition that only succeeds from NULL. If it updates 0 rows, the result is `already_sent …` or `already_attempted …`.
6. **Send.** `sendEmailStep({subscriberId, clientId, invoiceId, recipient, clientOptOutEmail}, mode)`.
7. **Release or keep the claim:**

| `sendEmailStep` result | Claim | Why |
|---|---|---|
| `sent` / `would_send` | Final (`sent` / `would_send`) | The email went out, or was recorded in test mode |
| `no_primary_contact` · `channel_denied` · `no_template` · `no_payment_link` · `recipient_not_found` | **Released** back to NULL | These checks return before any record or dispatch, so nothing left the building and the agent can retry |
| `send_failed` | **Final** (`failed`) | See below |
| `sendEmailStep` throws | **Final** (`failed`) | Same reasoning |

**How `send_failed` was classified.** `sendEmailStep`'s live branch wraps `dispatchEmail`, which is `lib/email.ts sendEmail`, in a single `try/catch`, and `sendEmail` can throw in three ways:
- **Before any request:** `APP_MAILERSEND_API_KEY` is unset.
- **After a request may have reached MailerSend:** `fetch` throws on a network reset or timeout. MailerSend may already have accepted the email.
- **After MailerSend rejected it:** a non-2xx response.

The catch can't tell these apart. A `communications` row with status `failed` also already exists by then. So `send_failed` **can't be proven to have happened before dispatch**, and it is treated as final: a double send is never risked. The same applies to an exception from `sendEmailStep`.

**What the agent hears:**

| Outcome | Text returned |
|---|---|
| Sent | `sent to <address>. Tell the caller to check their inbox.` |
| Test mode | `recorded in test mode, not delivered (would have gone to <address>).` |
| Duplicate | `already_sent: a payment link was already emailed on this call to <address>.` (test mode: `…recorded in test mode … not delivered.`) |
| Fixable problem | A short instruction, e.g. `That address is opted out of email, so I can't send to it. Is there another address?` |
| Anything else | Tell the caller the team will follow up |

## Recipient override in `sendEmailStep`

- `SendEmailStepContext` gains two optional fields:
  - `recipient?: { contactId } | { email }`
  - `clientOptOutEmail?: boolean`
- The port method becomes `loadRecipientContact(clientId, recipient?, clientOptOutEmail?)`. Its pure core is `pickRecipient` in `sendEmailStep.ts`.
- **No recipient → exactly today's selection.** It is called with `clientId` alone, so cadence and `outreach/run` are unchanged. A test captures today's selection.
- **The override replaces step 1 only.** Gate 2 (`isChannelAllowed` plus a non-empty email) then runs **unchanged** on whatever step 1 picked. No gate was reordered.
- **`contactId`:** it must be among this client's contacts, which is the ownership check. Missing → the new outcome `recipient_not_found`, and nothing is written.
- **`email`:** handled by `resolveAddressRecipient` in `selectRecipients.ts`.
  - If it matches an on-file contact (trimmed, case-insensitive), that row is used, so its own opt-out applies.
  - Otherwise a contact-shaped object with the address is used. It is not persisted.
- **Client-level opt-out.** Both override paths fold in `clients.opt_out_email` (`withClientEmailOptOut`). The default path does too, since the cadence follow-up. A flag the caller doesn't supply is read from the `clients` row; if that row can't be read, the send is refused.
- **What gets recorded.** Step 4 is unchanged: `to_address = contact.email`. A spoken address therefore lands verbatim in `communications.to_address` and shows in the Recovery Agent Exchanges timeline.
- Nothing is ever written to `client_contacts`.
- With no contact name, the greeting falls back to `client_name`.
- `VOICE_CHANNEL` moved from `lib/voice/buildCallVariables.ts` to `selectRecipients.ts`, next to `EMAIL_CHANNEL`.

## Other changes

- **`/api/voice/call` now requires `invoiceId`.** A missing one gets a 400 `invoiceId is required`. The agent's variables and its payment email both key off `voice_calls.invoice_id`. Before this, the 18 calls from Sep 12 had none.
- **`lib/voice/handoffEmail.ts`:** `maybeSendVoiceHandoffEmail` and its tests are deleted.
  - Kept: `createHandoffPort` (`claimOrRecord`, `finalize`), `parseHandoffMode`.
  - Added: `release` (a guarded `claimed` → NULL) and `loadPriorSend` (status plus `to_address`).
- **Retained settings:**
  - `VOICE_HANDOFF_EMAIL_MODE`: `dry_run` | `live`; anything else is OFF.
  - `VOICE_HANDOFF_EMAIL_CLIENT_ID`: optional single-client fence.
- No migration is needed: the `add_voice_calls_handoff_email` columns are reused as-is.

## Console runbook (Charles)

1. **Env (Test).** Keep `VOICE_HANDOFF_EMAIL_MODE=dry_run` and `VOICE_HANDOFF_EMAIL_CLIENT_ID=9e38c5f4-0d88-41c6-a968-394b9202f440`, then redeploy after merge.
2. **Register two Vapi function tools.** Give both the same server settings:
   - `server.url`: `https://dev-clyintel.vercel.app/api/voice/tools`
   - `server.headers`: `{ "x-vapi-secret": "<Test VAPI_WEBHOOK_SECRET>" }`
   - `async: false`, `server.timeoutSeconds`: 20

   The two tools:
   - `get_account`: no parameters. Description: *"Look up the account for this call: the invoice, the contacts on file with their email addresses, which contacts can be emailed, and whether a payment email was already sent on this call."*
   - `send_payment_email`: parameters `{ "type": "object", "properties": { "email": { "type": "string", "description": "An address the caller spoke and confirmed after you read it back. Omit to use an on-file contact." }, "contact_id": { "type": "string", "description": "A contact_id from get_account." } } }`. Description: *"Email the caller the secure payment link for this invoice. Only when the caller asks for it, and only after you have read the address back and they confirmed it."*
3. **Attach both tools** to the **Test Collections Agent** (`VAPI_ASSISTANT_ID_TEST`) and republish.
4. **Prompt edits** on that assistant:
   - Verify identity first: confirm you are speaking with someone who can speak for the account before discussing it.
   - Only send when the caller asks for the payment link by email, or agrees to receive one. Never send unprompted.
   - Call `get_account`. Offer the on-file email and **read it back** ("I have ap at acme dot com — is that right?"). If they give a new address, **read that back** letter by letter before sending.
   - Never read URLs or payment links aloud. The email is sent by the tool.
   - If the tool returns an `already_sent` line, tell the caller it's already on its way. Don't send again.
   - If the tool returns an error, follow its instruction (ask for another address, or say the team will follow up).
5. **Dry run.** Place a call with `test: true` against 0969 Ocean View Road and its open invoice.
   - Ask for the link, confirm the address, and check that the agent says it was recorded in test mode.
   - Check `voice_calls.handoff_email_status = 'would_send'`.
   - Check that the `communications.to_address` is the confirmed address and the link is the subscriber default.
6. **Duplicate.** On the same call, ask again. Expect "already sent" and still exactly one `communications` row.
7. **Opt-out.** Give an address belonging to an opted-out contact, or opt the client out. Expect an error, nothing written, and the agent asking for another address.
8. **Live.** Set `VOICE_HANDOFF_EMAIL_MODE=live`, place one call, and expect exactly one email and a `sent` row.
9. **Remove** the leftover `sendPaymentLink` `structuredDataPlan` from #140 if it's still on the assistant.

## Follow-ups (not in this PR)

- **`clients.opt_out_email` on the default cadence path:** done in "fix(outreach): apply client-level email opt-out on the default cadence path". `sendEmailStep`'s default port now reads the flag on every send, so an opted-out client gets `channel_denied`.
- A call-specific email template. Today's is the system-default dunning template, and the send counts toward the cadence cap.
- `/api/voice/call` takes `subscriberId` from the body (the pre-Beta gap noted in #140).

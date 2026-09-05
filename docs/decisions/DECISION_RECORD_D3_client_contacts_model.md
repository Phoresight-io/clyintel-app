# Decision Record D3: Client Contacts Model & the Contact/Score Boundary

**Status:** Accepted
**Owner:** Charles Weldon · Product/Ops: Claude (chat) · Executor: Claude Code

---

## 1. Context

The send path needs to resolve **who** outreach goes to, per customer, across three
channels (email, SMS, voice). The requirements that surfaced:

1. Customers have **multiple contacts**.
2. Two functional **kinds** of contact — **Point-of-Contact** (address of record) and
   **Dunning** (specific reachable addresses used for outreach).
3. Dunning contacts are **rank-ordered** for fallback.
4. Fallback is **per-channel** — an email failure escalates the email order, not SMS or voice.
5. Contact info is **sourced from QBO** when available.
6. The system must later support **channel-effectiveness** ("this customer pays faster via SMS").

This record fixes where each of those lives, and — load-bearingly — where
channel-effectiveness does **not** live.

---

## 2. Decision

1. **`client_contacts` is the executor-layer home for WHERE to send + fallback-within-channel.**
   Shape: `contact_type` (`poc | dunning`) + per-channel rank columns (`email_rank`,
   `sms_rank`, `voice_rank`; nullable integer; **null = the contact does not participate in
   that channel**) + the existing per-channel opt-outs (`opt_out_email` / `opt_out_sms` /
   `opt_out_voice`). One row per contact/person.

2. **Ranking is per `(contact, channel)`, not per contact.** A channel failure escalates
   *that channel's* rank order only; it never disturbs another channel's order. An email
   bounce must not reorder SMS or voice.

3. **PoC vs Dunning.** PoC = address(es) of record, **sourced from QBO** (multiple if QBO
   exposes them), blank if none. Dunning = user-added specific reachable addresses,
   per-channel ranked. Send **prefers dunning (by rank), then falls back to PoC**.

4. **Escalation criteria deferred.** The schema *supports* ranked fallback; **when** to
   escalate down the ranks is not defined now (Agent-2 / strategist territory). The executor
   uses **rank = 1 (Primary) only** until Agent 2 defines escalation.

5. **THE BOUNDARY (load-bearing).** Channel-**propensity** — which channel a given customer
   pays faster through — is **Client Score / Agent-2 data, NOT a contacts column.** It is a
   per-customer-per-channel effectiveness score that **feeds** channel choice. It **must NOT**
   be added to `client_contacts`.
   *Rationale:* propensity is customer-level strategist data; placing it on contact-level
   executor rows violates the Agent-1 / Agent-2 boundary and couples strategy into the
   executor. This separation is what makes the model scale.

6. **`is_primary` is superseded by per-channel ranks** (`email_rank = 1` ⇒ primary email).
   Retire or derive it in later cleanup; **ranks are authoritative**.

7. **Rank columns on the row, NOT a normalized `(contact, channel, rank)` join table.**
   Channels are a fixed set of three; the executor layer stays simple. The extensibility a
   join table would buy belongs to the **score layer**, not here.

---

## 3. The boundary, drawn

```
 Agent 1 — EXECUTOR                        │  Agent 2 — STRATEGIST
 client_contacts                           │  Client Score
 ─────────────────                         │  ────────────────
 WHERE to send + fallback WITHIN a channel │  WHICH channel to prefer (propensity)
 contact_type (poc | dunning)              │  per-customer-per-channel effectiveness
 email_rank / sms_rank / voice_rank        │  feeds channel choice
 opt_out_email / _sms / _voice             │
                                           │
 rank = 1 only, until Agent 2 defines ─────┼──► escalation criteria (deferred)
 escalation                                │
```

Propensity never becomes a `client_contacts` column. Contact rows never carry a
"pays-faster-via" signal.

---

## 4. Rejected alternatives (do not re-litigate)

- **Propensity/effectiveness column on `client_contacts`** — rejected: it is customer-level
  strategist data on contact-level executor rows; couples Agent 2 into Agent 1 and breaks the
  boundary that lets the model scale (Decision 5).
- **Normalized `(contact, channel, rank)` join table** — rejected for the executor: channels
  are a fixed three; rank columns keep the executor simple. Join-table extensibility belongs
  to the score layer (Decision 7).
- **Per-contact single rank (not per-channel)** — rejected: a failure on one channel would
  reorder the others; fallback must be isolated per channel (Decision 2).

---

## 5. Consequences

A **contacts subsystem workstream** follows:

- **Schema:** `contact_type` + three per-channel rank columns on `client_contacts`.
- **QBO multi-contact sync:** pull PoC address(es) of record from QBO.
- **FE:** view PoC + manage ranked dunning contacts.
- **Send path:** per-channel, rank-aware recipient selection (rank = 1 until escalation is
  defined).

**Channel-propensity ranking is a named future seam in the Agent-2 / Client Score
workstream — explicitly out of scope for `client_contacts`.**

# PRODUCT_CONTEXT.md — clyintel
_Open D3 product context_
_Generated: 2026-05-16 · Based on PRD v1.6_

---

## Product

**Name:** Clyintel  
**Slug:** `clyintel`  
**Positioning:** Payment Intelligence Built for Small Businesses — sell outcomes, not AI.

**What it does:**
AI-powered accounts receivable and collections intelligence platform for solopreneurs and small businesses. Recovers overdue receivables through automated outreach and predictive insights — no manual follow-up required.

---

## User Tiers

| Plan | Price | Recovery Limit | Rev Share Rate | Billing Paths |
|---|---|---|---|---|
| Free | $0 | 1/mo | 22% | Revenue Share only |
| Starter | $29/mo | 5/mo | 18% | Revenue Share · Subscription |
| Plus | $79/mo | 20/mo | 12% | Revenue Share · Subscription |
| Pro | $149/mo | 50/mo | 8% | Revenue Share · Subscription |
| Enterprise | Custom | Unlimited | 5% | Revenue Share only |

---

## Business Rules

1. Free users cannot access Subscription billing.
2. Free users are capped at 1 recovery per month.
3. AI SMS Agent is Pro/Enterprise only.
4. AI Voice Agent is Pro/Enterprise only (stretch goal — not Phase 1).
5. Usage counters reset on the 1st of each month via Airtable automation.
6. Invoice statuses shown to subscribers: Current · Due Soon · Past Due · Recovered
7. Promise to Pay and Written Off are Airtable-only — never shown in subscriber UI.
8. Exchange Drawer channels at launch: Email + SMS. Voice = stretch goal.
9. Add Client sources at launch: Manual Entry + QuickBooks Online. All others = Coming Soon.
10. Score delta and Next Action column are stretch goals — not Phase 1.
11. Subscription Plan on Subscribers must be a linkedRecord → Plans. Never revert to singleSelect.
12. typecast: true required for all Single Select Airtable API writes.
13. Rollup fields cannot be created via Airtable API — use Omni or Airtable UI.

---

## Compliance

- **PCI-DSS:** Payment handling delegated entirely to Stripe. Formal scope verification required before launch.

---

## Airtable Base

**Base ID:** `appB9RBtlceibhEqn`

| Table | ID |
|---|---|
| Plans | tblmSqLFwCbAMznDm |
| Subscribers | tblRaPBOf5SKh4SYz |
| Clients | tblyib5Mq7seLlgta |
| Invoices | tblM0Ir1wLcA1U4Fn |
| Communications | tblKLGkCloIBsudF4 |
| Templates | tbl8AMzAu2zjuyEVm |
| Payments | tblax7uTJQz2cNdzn |
| Connected Accounts | tblOYWFtbrkq2MZbL |
| Invoice Payments | tbl1C2OhyS6DmLx97 |
| Recoveries | tblFzpLu23543SePn |
| Client Scores | tblYxf3Aoj1gs5DiH |
| PT Recommendations | tblHCLskZYPht9rXq |

### Plan Record IDs

| Plan | Record ID | Stripe Product ID |
|---|---|---|
| Free | recQ98gWDhvJsOcMA | — |
| Starter | recz5JJ2QvECFSO9v | prod_UG5P6BwawRlmf2 |
| Plus | recxf65JVeQmRmdcj | prod_UG5Pn5BS7UGHtD |
| Pro | rec1VrRPV6gHN5urL | prod_UG5Q9TLOQd99ey |
| Enterprise | recgmndIhf30lQxa4 | prod_UG5RcrHZXFGLmk |

### Key Subscriber Field IDs

| Field | ID | Type |
|---|---|---|
| Subscription Plan | fldVS45Zl1CE3GYMz | linkedRecord → Plans |
| Billing Path | fldp06Ky2WaHV5c4E | singleSelect |
| Stripe Customer ID | fldVyl4J565CFzIEV | text |
| Recoveries Used This Month | fldALS2i2aMGp0cYp | number |
| Client Scores Used This Month | fldJqp1WBurDQ0W3x | number |
| PT Recs Used This Month | fldrz2MA7qTWDGZo3 | number |
| Recovery Limit Reached | fldrt3xzyby6gcGVj | checkbox |
| AI SMS Agent Enabled | fldasNacBzZq6m1PZ | checkbox |
| AI Voice Agent Enabled | fld2c0U247Met8xBs | checkbox |

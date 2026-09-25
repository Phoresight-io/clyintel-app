import { describe, it, expect } from "vitest";
import {
  computeClientScore,
  riskLevelFor,
  delinquencyBand,
  formatCents,
  type ScoreInputs,
  type ScoreInvoice,
} from "./computeClientScore";

const AS_OF = new Date("2026-09-25T12:00:00Z");

function inv(p: Partial<ScoreInvoice> & { id: string }): ScoreInvoice {
  return {
    status: "sent",
    due_date: null,
    issue_date: null,
    created_at: "2026-05-01T00:00:00Z",
    amount_cents: 0,
    amount_outstanding_cents: null,
    ...p,
  };
}

// Known-count fixture. Expected values are worked by hand:
//   paid with timing: i1 on time, i2 18 days late (last of two payments), i3 same day = on time
//   past due: i4 32 days (due 2026-08-24; daysFromToday rounds −32.5 → −32)
//   total billed non-draft = 1000+500+300+800+440 = $3,040.00; past due $800.00
//   outbound 5, replied 1 (c1), then the 4 newest are unanswered
function fixture(): ScoreInputs {
  return {
    asOf: AS_OF,
    invoices: [
      inv({ id: "i1", status: "paid", due_date: "2026-06-10", issue_date: "2026-05-11", amount_cents: 100000, amount_outstanding_cents: 0 }),
      inv({ id: "i2", status: "paid", due_date: "2026-07-10", issue_date: "2026-06-10", amount_cents: 50000, amount_outstanding_cents: 0 }),
      inv({ id: "i3", status: "paid", due_date: "2026-08-10", issue_date: "2026-07-10", amount_cents: 30000, amount_outstanding_cents: 0 }),
      inv({ id: "i4", status: "overdue", due_date: "2026-08-24", issue_date: "2026-07-25", amount_cents: 80000, amount_outstanding_cents: 80000 }),
      inv({ id: "i5", status: "sent", due_date: "2026-10-15", issue_date: "2026-09-15", amount_cents: 44000, amount_outstanding_cents: 44000 }),
      inv({ id: "i6", status: "draft", due_date: "2026-01-01", issue_date: "2026-01-01", amount_cents: 999999 }),
    ],
    paidTimings: [
      { invoice_id: "i1", paid_at: "2026-06-08T15:00:00+00:00" },
      { invoice_id: "i2", paid_at: "2026-07-01T10:00:00+00:00" },
      { invoice_id: "i2", paid_at: "2026-07-28T10:00:00+00:00" },
      { invoice_id: "i3", paid_at: "2026-08-10T23:00:00+00:00" },
    ],
    comms: [
      { invoice_id: "i2", direction: "outbound", sent_at: "2026-07-12T09:00:00Z", created_at: "2026-07-12T09:00:00Z", reply_received_at: "2026-07-13T09:00:00Z" },
      { invoice_id: "i4", direction: "outbound", sent_at: "2026-09-01T09:00:00Z", created_at: "2026-09-01T09:00:00Z", reply_received_at: null },
      { invoice_id: "i4", direction: "outbound", sent_at: "2026-09-10T09:00:00Z", created_at: "2026-09-10T09:00:00Z", reply_received_at: null },
      { invoice_id: "i4", direction: "outbound", sent_at: "2026-09-20T09:00:00Z", created_at: "2026-09-20T09:00:00Z", reply_received_at: null },
      { invoice_id: "i5", direction: "outbound", sent_at: null, created_at: "2026-09-22T09:00:00Z", reply_received_at: null },
    ],
  };
}

function scored(input: ScoreInputs) {
  const r = computeClientScore(input);
  if (r.kind !== "scored") throw new Error("expected scored");
  return r;
}

describe("computeClientScore — known fixture (every line traceable to inputs)", () => {
  it("computes components, composite, band and numeric columns", () => {
    const r = scored(fixture());
    const inputs = r.inputs as Record<string, any>;
    expect(inputs.components).toEqual({
      paymentHistory: 66.67,
      currentDelinquency: 35,
      exposure: 73.68,
      responsiveness: 20,
    });
    // .4*66.67 + .3*35 + .15*73.68 + .15*20 = 51.22 → 51
    expect(r.composite_score).toBe(51);
    expect(r.risk_level).toBe("high");
    expect(r.payment_history_score).toBe(66.67);
    expect(r.avg_days_overdue).toBe(25); // (18 + 32) / 2
    expect(r.non_response_rate).toBe(0.8);
    expect(r.outstanding_amount_cents).toBe(80000);
    expect(r.dispute_rate).toBeNull();
    expect(r.ai_model).toBeNull();
    expect(r.ai_recommendation).toBeNull();
    expect(r.score_date).toBe("2026-09-25");
    expect(r.score_month).toBe("2026-09");
    expect(inputs.aggregates).toMatchObject({
      non_draft_invoices: 5,
      paid_with_timing: 3,
      paid_late: 1,
      past_due_count: 1,
      max_days_past_due: 32,
      total_billed_cents: 304000,
      outbound_count: 5,
      replied_count: 1,
      unanswered_streak: 4,
    });
    expect(inputs.weights_used).toEqual({ paymentHistory: 0.4, currentDelinquency: 0.3, exposure: 0.15, responsiveness: 0.15 });
  });

  it("produces exact text lines", () => {
    const r = scored(fixture());
    expect(r.score_summary).toEqual(["Elevated collection risk", "Based on 5 invoices since May 2026"]);
    expect(r.score_factors).toEqual([
      "1 of 3 paid invoices were late",
      "$800.00 past due across 1 invoice",
      "Average delay: 25 days",
      "Replied to 1 of 5 outreach messages",
    ]);
    // Lowest three components below 80: responsiveness 20, delinquency 35, history 66.67.
    expect(r.risk_drivers).toEqual([
      "No replies to the last 4 outreach attempts",
      "Oldest open invoice is 32 days past due",
      "Paid 1 of 3 invoices after the due date",
    ]);
  });

  it("trend line replaces the data-basis line when a prior score exists", () => {
    const r = scored({ ...fixture(), prior: { composite_score: 57, score_date: "2026-08-31" } });
    expect(r.score_summary).toEqual(["Elevated collection risk", "Down 6 points since Aug 2026"]);
    const up = scored({ ...fixture(), prior: { composite_score: 50, score_date: "2026-08-31" } });
    expect(up.score_summary[1]).toBe("Up 1 point since Aug 2026");
    const same = scored({ ...fixture(), prior: { composite_score: 51, score_date: "2026-08-31" } });
    expect(same.score_summary[1]).toBe("Unchanged since Aug 2026");
  });
});

describe("computeClientScore — determinism", () => {
  it("same inputs → identical ScoreResult, including text lists", () => {
    const a = computeClientScore(fixture());
    const b = computeClientScore(fixture());
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("input ordering does not change the result", () => {
    const f = fixture();
    const reversed = { ...f, invoices: [...f.invoices].reverse(), paidTimings: [...f.paidTimings].reverse(), comms: [...f.comms].reverse() };
    const a = scored(f);
    const b = scored(reversed);
    expect(b.composite_score).toBe(a.composite_score);
    expect(b.score_summary).toEqual(a.score_summary);
    expect(b.score_factors).toEqual(a.score_factors);
    expect(b.risk_drivers).toEqual(a.risk_drivers);
  });
});

describe("computeClientScore — graceful degradation", () => {
  it("no paid_at data → paymentHistory null, weights renormalized, no paid-late line", () => {
    const r = scored({ ...fixture(), paidTimings: [] });
    const inputs = r.inputs as Record<string, any>;
    expect(inputs.components.paymentHistory).toBeNull();
    expect(r.payment_history_score).toBeNull();
    expect(inputs.weights_used).toEqual({ currentDelinquency: 0.5, exposure: 0.25, responsiveness: 0.25 });
    // .5*35 + .25*73.68 + .25*20 = 40.92 → 41
    expect(r.composite_score).toBe(41);
    expect(r.score_factors.some((l) => /paid invoices? (was|were) late/.test(l))).toBe(false);
    expect(r.risk_drivers.some((l) => /after the due date/.test(l))).toBe(false);
    expect(r.score_summary).toContain("Payment timing not scored: no payment dates on record");
    // Only the past-due invoice contributes to the average delay now.
    expect(r.avg_days_overdue).toBe(32);
  });

  it("paid_at null on a payment row is treated as unknown, not on-time", () => {
    const r = scored({ ...fixture(), paidTimings: [{ invoice_id: "i1", paid_at: null }] });
    expect((r.inputs as any).components.paymentHistory).toBeNull();
  });

  it("no outbound comms → responsiveness null, no reply-rate line", () => {
    const r = scored({ ...fixture(), comms: [] });
    const inputs = r.inputs as Record<string, any>;
    expect(inputs.components.responsiveness).toBeNull();
    expect(r.non_response_rate).toBeNull();
    expect(r.score_factors.some((l) => /Replied to/.test(l))).toBe(false);
    expect(r.risk_drivers.some((l) => /repl/i.test(l))).toBe(false);
    expect(r.score_summary).toContain("Responsiveness not scored: no outreach sent yet");
  });

  it("an inbound row on the same invoice counts as a reply", () => {
    const f = fixture();
    const r = scored({
      ...f,
      comms: [
        { invoice_id: "i4", direction: "outbound", sent_at: "2026-09-01T09:00:00Z", created_at: "2026-09-01T09:00:00Z", reply_received_at: null },
        { invoice_id: "i4", direction: "inbound", sent_at: null, created_at: "2026-09-02T09:00:00Z", reply_received_at: null },
      ],
    });
    expect((r.inputs as any).components.responsiveness).toBe(100);
    expect(r.score_factors).toContain("Replied to 1 of 1 outreach message");
  });

  it("written_off counts as paid late for paymentHistory", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [inv({ id: "w", status: "written_off", due_date: "2026-09-20", amount_cents: 10000, amount_outstanding_cents: 10000 })],
      paidTimings: [],
      comms: [],
    });
    expect(r.payment_history_score).toBe(0);
    expect(r.score_factors).toContain("1 invoice written off");
    expect(r.risk_drivers).toContain("1 invoice written off as uncollectible");
  });
});

describe("computeClientScore — insufficient data", () => {
  it("no invoices → insufficient_data", () => {
    expect(computeClientScore({ asOf: AS_OF, invoices: [], paidTimings: [], comms: [] })).toEqual({ kind: "insufficient_data" });
  });
  it("only drafts → insufficient_data", () => {
    expect(
      computeClientScore({ asOf: AS_OF, invoices: [inv({ id: "d", status: "draft", amount_cents: 5000 })], paidTimings: [], comms: [] }),
    ).toEqual({ kind: "insufficient_data" });
  });
});

describe("risk bands and delinquency bands", () => {
  it.each([
    [100, "low"], [80, "low"], [79, "medium"], [60, "medium"], [59, "high"], [40, "high"], [39, "critical"], [0, "critical"],
  ] as const)("%i → %s", (score, level) => {
    expect(riskLevelFor(score)).toBe(level);
  });

  it.each([
    [0, 100], [1, 80], [15, 80], [16, 60], [30, 60], [31, 35], [60, 35], [61, 15], [90, 15], [91, 0],
  ])("max %i days past due → %i", (days, band) => {
    expect(delinquencyBand(days)).toBe(band);
  });

  it("clean client → low risk with no drivers", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [inv({ id: "a", status: "paid", due_date: "2026-09-01", issue_date: "2026-08-01", amount_cents: 12345, amount_outstanding_cents: 0 })],
      paidTimings: [{ invoice_id: "a", paid_at: "2026-08-30T00:00:00Z" }],
      comms: [],
    });
    expect(r.composite_score).toBe(100);
    expect(r.risk_level).toBe("low");
    expect(r.score_summary[0]).toBe("Reliable payer");
    expect(r.score_factors).toEqual(["0 of 1 paid invoice was late", "No invoices past due"]);
    expect(r.risk_drivers).toEqual(["No material risk drivers identified"]);
  });

  it("summary/factors/drivers stay within 2–4 lines when every component is present", () => {
    const r = scored(fixture());
    for (const list of [r.score_summary, r.score_factors]) {
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.length).toBeLessThanOrEqual(4);
    }
    expect(r.risk_drivers.length).toBeGreaterThanOrEqual(1);
    expect(r.risk_drivers.length).toBeLessThanOrEqual(3);
  });
});

describe("formatCents", () => {
  it("formats cents to 2-decimal dollars with grouping", () => {
    expect(formatCents(124000)).toBe("$1,240.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });
});

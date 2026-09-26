import { describe, it, expect } from "vitest";
import { computeClientScore, formatCents, SCORER_VERSION, type ScoreInputs, type ScoreInvoice } from "./computeClientScore";
import { resolvePaidTimings } from "./resolvePaidTimings";
import regression from "./__fixtures__/testClients-2026-09-25.json";
import type { PaidTiming } from "./resolvePaidTimings";

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

// Known-count fixture. Hand-worked expectations:
//   dated paid: i1 −2d → 100 ($1,000), i2 18d → 65 ($500), i3 0d → 100 ($300)
//   written_off: i8 → 0 ($100)
//   weighted mean = (100·1000 + 65·500 + 100·300 + 0·100) / 1900 = 85.5263
//   history = (4 · 85.5263 + 70) / 5 = 82.42
//   past due (written_off excluded): i4 32 days → 50; $800 of $3,340 billed → exposure 76.05
//   composite = .55·82.42 + .30·50 + .15·76.05 = 71.74 → 72 → medium
//   i7 is paid but undated → not in history
function timings(i2Source: PaidTiming["date_source"] = "detected"): PaidTiming[] {
  return [
    { invoice_id: "i1", paid_date: "2026-06-08", date_source: "payment" },
    { invoice_id: "i2", paid_date: "2026-07-28", date_source: i2Source },
    { invoice_id: "i3", paid_date: "2026-08-10", date_source: "qbo_txn" },
  ];
}
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
      inv({ id: "i7", status: "paid", due_date: "2026-05-30", issue_date: "2026-05-15", amount_cents: 20000, amount_outstanding_cents: 0 }),
      inv({ id: "i8", status: "written_off", due_date: "2026-07-01", issue_date: "2026-06-01", amount_cents: 10000, amount_outstanding_cents: 10000 }),
    ],
    paidTimings: timings(),
  };
}

function scored(input: ScoreInputs) {
  const r = computeClientScore(input);
  if (r.kind !== "scored") throw new Error("expected scored");
  return r;
}
const inputsOf = (r: { inputs: unknown }) => r.inputs as Record<string, any>;

describe("computeClientScore v1 — known fixture", () => {
  it("computes components, composite, band and numeric columns", () => {
    const r = scored(fixture());
    const inputs = inputsOf(r);
    expect(inputs.version).toBe(SCORER_VERSION);
    expect(SCORER_VERSION).toBe("v1.1");
    expect(inputs.components).toEqual({ paymentHistory: 82.42, currentDelinquency: 50, exposure: 76.05 });
    expect(r.composite_score).toBe(72);
    expect(r.risk_level).toBe("medium");
    expect(r.payment_history_score).toBe(82.42);
    expect(r.avg_days_overdue).toBe(25); // (18 late-paid + 32 past due) / 2
    expect(r.non_response_rate).toBeNull();
    expect(r.dispute_rate).toBeNull();
    expect(r.outstanding_amount_cents).toBe(80000); // written_off excluded
    expect(r.score_date).toBe("2026-09-25");
    expect(r.score_month).toBe("2026-09");
    expect(inputs.provisional).toBe(false);
    expect(inputs.prior).toBe(70);
    expect(inputs.weights).toEqual({ paymentHistory: 0.55, currentDelinquency: 0.3, exposure: 0.15 });
    expect(inputs.undated_paid_count).toBe(1);
    expect(inputs.detected_fallback_count).toBe(1);
    expect(inputs.no_due_date_count).toBe(0);
    expect(inputs.timings.map((t: any) => [t.invoice_id, t.date_source, t.days_late, t.lateness_score])).toEqual([
      ["i1", "payment", -2, 100],
      ["i2", "detected", 18, 65],
      ["i3", "qbo_txn", 0, 100],
    ]);
    expect(inputs.aggregates).toMatchObject({
      non_draft_invoices: 7,
      dated_paid: 3,
      dated_paid_on_time: 2,
      dated_paid_late: 1,
      written_off: 1,
      history_n: 4,
      past_due_count: 1,
      past_due_outstanding_cents: 80000,
      max_days_past_due: 32,
      total_billed_cents: 334000,
    });
  });

  it("produces exact text lines traceable to inputs", () => {
    const r = scored(fixture());
    expect(r.score_summary).toEqual([
      "Usually pays, sometimes late",
      "Based on 7 invoices since May 2026",
      "1 paid invoice has no payment date — not used in the score",
    ]);
    expect(r.score_factors).toEqual([
      "2 of 3 dated payments were on time",
      "Average delay: 18 days", // paid-late only (i2); open past-due age is not mixed in
      "$800.00 past due across 1 invoice",
      "1 invoice written off",
    ]);
    // Only delinquency (50) is below 70.
    expect(r.risk_drivers).toEqual(["Oldest open invoice is 32 days past due ($800.00)"]);
  });

  it("trend line replaces the data-basis line when a prior score exists", () => {
    const f = fixture();
    expect(scored({ ...f, prior: { composite_score: 78, score_date: "2026-08-31" } }).score_summary[1]).toBe("Down 6 points since Aug 2026");
    expect(scored({ ...f, prior: { composite_score: 71, score_date: "2026-08-31" } }).score_summary[1]).toBe("Up 1 point since Aug 2026");
    expect(scored({ ...f, prior: { composite_score: 72, score_date: "2026-08-31" } }).score_summary[1]).toBe("Unchanged since Aug 2026");
  });
});

describe("computeClientScore v1 — source-agnostic", () => {
  it("the same paid_date from any source yields identical scoring output", () => {
    const results = (["payment", "qbo_txn", "detected"] as const).map((src) =>
      scored({ ...fixture(), paidTimings: timings(src) }),
    );
    for (const r of results.slice(1)) {
      expect(r.composite_score).toBe(results[0].composite_score);
      expect(r.risk_level).toBe(results[0].risk_level);
      expect(r.score_summary).toEqual(results[0].score_summary);
      expect(r.score_factors).toEqual(results[0].score_factors);
      expect(r.risk_drivers).toEqual(results[0].risk_drivers);
      expect(inputsOf(r).components).toEqual(inputsOf(results[0]).components);
    }
    // Only the audit fields differ.
    expect(inputsOf(results[0]).detected_fallback_count).toBe(0);
    expect(inputsOf(results[2]).detected_fallback_count).toBe(1);
  });
});

describe("computeClientScore v1 — determinism", () => {
  it("same inputs → identical ScoreResult", () => {
    expect(JSON.stringify(computeClientScore(fixture()))).toBe(JSON.stringify(computeClientScore(fixture())));
  });
  it("input ordering does not change the result", () => {
    const f = fixture();
    const a = computeClientScore(f);
    const b = computeClientScore({ ...f, invoices: [...f.invoices].reverse(), paidTimings: [...f.paidTimings].reverse() });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
  it("duplicate timings for one invoice: latest paid_date wins", () => {
    const f = fixture();
    const r = scored({ ...f, paidTimings: [...f.paidTimings, { invoice_id: "i1", paid_date: "2026-06-01", date_source: "detected" }] });
    expect(inputsOf(r).timings[0]).toMatchObject({ invoice_id: "i1", paid_date: "2026-06-08", date_source: "payment" });
  });
});

describe("computeClientScore v1 — no dated payments (prior only)", () => {
  // Paid but undated ($1,000) + one invoice 10 days past due ($500).
  // history = 70 (n = 0), delinquency 80, exposure 66.67
  // .55·70 + .30·80 + .15·66.67 = 72.50 → 73 → medium
  function noTiming(): ScoreInputs {
    return {
      asOf: AS_OF,
      invoices: [
        inv({ id: "p", status: "paid", due_date: "2026-08-01", issue_date: "2026-07-01", amount_cents: 100000, amount_outstanding_cents: 0 }),
        inv({ id: "o", status: "overdue", due_date: "2026-09-15", issue_date: "2026-08-15", amount_cents: 50000, amount_outstanding_cents: 50000 }),
      ],
      paidTimings: [],
    };
  }

  it("history = 70, all three components present (no renormalization), provisional", () => {
    const r = scored(noTiming());
    expect(inputsOf(r).components).toEqual({ paymentHistory: 70, currentDelinquency: 80, exposure: 66.67 });
    expect(r.composite_score).toBe(73);
    expect(r.risk_level).toBe("medium");
    expect(inputsOf(r).provisional).toBe(true);
  });

  it("timing-neutral headline, undated callout second with (limited history), prior never cited", () => {
    const r = scored(noTiming());
    expect(r.score_summary).toEqual([
      "Moderate collection risk",
      "1 paid invoice has no payment date — not used in the score (limited history)",
      "Based on 2 invoices since Jul 2026",
    ]);
    // No late PAID invoices → no "Average delay" line (the open invoice is covered below).
    expect(r.score_factors).toEqual(["$500.00 past due across 1 invoice", "$1,500.00 billed across 2 invoices"]);
    expect(r.risk_drivers).toEqual(["33% of billed amount is past due ($500.00)"]);
    for (const line of [...r.score_summary, ...r.score_factors, ...r.risk_drivers]) {
      expect(line).not.toMatch(/on time|paid .* late|70/i);
    }
  });

  it("invoices with no due_date are excluded from history and counted", () => {
    const r = scored({
      ...noTiming(),
      invoices: [inv({ id: "p", status: "paid", due_date: null, amount_cents: 100000, amount_outstanding_cents: 0 })],
      paidTimings: [{ invoice_id: "p", paid_date: "2026-08-01", date_source: "payment" }],
    });
    expect(inputsOf(r).no_due_date_count).toBe(1);
    expect(inputsOf(r).components.paymentHistory).toBe(70);
    expect(inputsOf(r).aggregates.history_n).toBe(0);
  });
});

describe("computeClientScore v1 — written_off is not double-counted", () => {
  it("written_off scores 0 in history but is excluded from delinquency and exposure", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [inv({ id: "w", status: "written_off", due_date: "2026-07-01", amount_cents: 10000, amount_outstanding_cents: 10000 })],
      paidTimings: [],
    });
    // history (1·0 + 70)/2 = 35; delinquency 100; exposure 100 → .55·35 + 30 + 15 = 64.25 → 64
    expect(inputsOf(r).components).toEqual({ paymentHistory: 35, currentDelinquency: 100, exposure: 100 });
    expect(r.composite_score).toBe(64);
    expect(r.risk_level).toBe("high");
    expect(r.outstanding_amount_cents).toBe(0);
    expect(r.score_summary[0]).toBe("High collection risk"); // zero dated payments
    expect(r.score_factors).toEqual(["No invoices past due", "1 invoice written off"]);
    expect(r.risk_drivers).toEqual(["1 of 1 invoice written off"]);
    expect(r.risk_drivers.some((l) => /Oldest open invoice/.test(l))).toBe(false);
  });
});

describe("computeClientScore v1 — amount weighting and drivers", () => {
  it("history is amount-weighted; late history driver shows count and average delay", () => {
    // $100 on time (100) + $900 paid 50 days late (35): mean = (100·100 + 35·900)/1000 = 41.5
    // n = 2 → history = (2·41.5 + 70)/3 = 51
    const r = scored({
      asOf: AS_OF,
      invoices: [
        inv({ id: "a", status: "paid", due_date: "2026-06-01", amount_cents: 10000, amount_outstanding_cents: 0 }),
        inv({ id: "b", status: "paid", due_date: "2026-06-01", amount_cents: 90000, amount_outstanding_cents: 0 }),
      ],
      paidTimings: [
        { invoice_id: "a", paid_date: "2026-06-01", date_source: "payment" },
        { invoice_id: "b", paid_date: "2026-07-21", date_source: "detected" },
      ],
    });
    expect(inputsOf(r).components.paymentHistory).toBe(51);
    // .55·51 + 30 + 15 = 73.05 → 73 → medium
    expect(r.composite_score).toBe(73);
    expect(r.score_summary[0]).toBe("Moderate collection risk"); // 2 dated < 3 → timing-neutral
    expect(r.risk_drivers).toEqual(["Paid 1 of 2 invoices late (avg 50 days)"]);
    expect(r.score_factors).toContain("1 of 2 dated payments were on time");
  });

  it("clean client → low risk, Reliable payer, no drivers", () => {
    const f = (id: string, due: string) => inv({ id, status: "paid", due_date: due, amount_cents: 1000, amount_outstanding_cents: 0 });
    const r = scored({
      asOf: AS_OF,
      invoices: [f("a", "2026-06-01"), f("b", "2026-07-01"), f("c", "2026-08-01")],
      paidTimings: ["a", "b", "c"].map((id) => ({ invoice_id: id, paid_date: "2026-05-30", date_source: "payment" as const })),
    });
    // history (3·100 + 70)/4 = 92.5 → .55·92.5 + 30 + 15 = 95.88 → 96
    expect(r.composite_score).toBe(96);
    expect(r.risk_level).toBe("low");
    expect(inputsOf(r).provisional).toBe(false);
    expect(r.score_summary[0]).toBe("Reliable payer");
    expect(r.score_factors).toEqual(["3 of 3 dated payments were on time", "No invoices past due"]);
    expect(r.risk_drivers).toEqual(["No material risk drivers identified"]);
  });
});

describe("polish — headline needs >= 3 dated payments", () => {
  const paid = (id: string) => inv({ id, status: "paid", due_date: "2026-06-01", amount_cents: 1000, amount_outstanding_cents: 0 });
  const onTime = (id: string): PaidTiming => ({ invoice_id: id, paid_date: "2026-05-30", date_source: "payment" });
  const run = (ids: string[]) =>
    scored({ asOf: AS_OF, invoices: ids.map(paid), paidTimings: ids.map(onTime) });

  it("1 dated payment → timing-neutral headline; evidence still in factors", () => {
    const r = run(["a"]);
    expect(r.composite_score).toBe(92); // history 85 → .55·85 + 30 + 15 = 91.75
    expect(r.score_summary[0]).toBe("Low collection risk");
    expect(r.score_factors[0]).toBe("1 of 1 dated payment was on time");
  });

  it("2 dated payments → timing-neutral headline", () => {
    expect(run(["a", "b"]).score_summary[0]).toBe("Low collection risk");
  });

  it("3 dated payments → timing headline", () => {
    expect(run(["a", "b", "c"]).score_summary[0]).toBe("Reliable payer");
  });

  it("a single late payment no longer produces a timing headline", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [paid("a")],
      paidTimings: [{ invoice_id: "a", paid_date: "2026-07-01", date_source: "detected" }], // 30 days → 65
    });
    // history (65 + 70)/2 = 67.5 → .55·67.5 + 45 = 82.13 → 82 → medium
    expect(r.risk_level).toBe("medium");
    expect(r.score_summary[0]).toBe("Moderate collection risk");
    expect(r.score_factors[0]).toBe("0 of 1 dated payment was on time");
  });
});

describe("polish — Average delay = paid-late invoices only", () => {
  it("no late paid + an open past-due invoice → no Average delay line; column stays blended", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [
        inv({ id: "a", status: "paid", due_date: "2026-06-01", amount_cents: 1000, amount_outstanding_cents: 0 }),
        inv({ id: "o", status: "overdue", due_date: "2026-09-05", amount_cents: 1000, amount_outstanding_cents: 1000 }),
      ],
      paidTimings: [{ invoice_id: "a", paid_date: "2026-06-01", date_source: "payment" }],
    });
    expect(r.score_factors.some((l) => l.startsWith("Average delay"))).toBe(false);
    expect(r.avg_days_overdue).toBe(20); // column: the open invoice's 20 days
  });

  it("with late paid invoices → mean of paid-late days only", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [
        inv({ id: "a", status: "paid", due_date: "2026-06-01", amount_cents: 1000, amount_outstanding_cents: 0 }),
        inv({ id: "b", status: "paid", due_date: "2026-06-01", amount_cents: 1000, amount_outstanding_cents: 0 }),
        inv({ id: "o", status: "overdue", due_date: "2026-06-27", amount_cents: 1000, amount_outstanding_cents: 1000 }),
      ],
      paidTimings: [
        { invoice_id: "a", paid_date: "2026-06-11", date_source: "payment" }, // 10 late
        { invoice_id: "b", paid_date: "2026-06-21", date_source: "payment" }, // 20 late
      ],
    });
    expect(r.score_factors).toContain("Average delay: 15 days"); // (10 + 20)/2, not the 90-day open invoice
    expect(r.avg_days_overdue).toBe(40); // column blends: (10 + 20 + 90)/3
  });
});

describe("exact spec cases owed from #137", () => {
  const paid = (id: string, cents: number) =>
    inv({ id, status: "paid", due_date: "2026-06-01", amount_cents: cents, amount_outstanding_cents: 0 });

  it("$5,000 on time + $200 at 60d late → weighted mean 97.5", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [paid("a", 500000), paid("b", 20000)],
      paidTimings: [
        { invoice_id: "a", paid_date: "2026-06-01", date_source: "payment" },
        { invoice_id: "b", paid_date: "2026-07-31", date_source: "payment" }, // 60 days → 35
      ],
    });
    expect(inputsOf(r).aggregates.history_weighted_mean).toBe(97.5);
  });

  it("one on-time payment → history 85", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [paid("a", 1000)],
      paidTimings: [{ invoice_id: "a", paid_date: "2026-06-01", date_source: "payment" }],
    });
    expect(r.payment_history_score).toBe(85);
  });

  it("one 10-days-late payment → history 75", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [paid("a", 1000)],
      paidTimings: [{ invoice_id: "a", paid_date: "2026-06-11", date_source: "payment" }],
    });
    expect(r.payment_history_score).toBe(75);
  });

  it("new client, nothing overdue, no dated payments → composite 84, medium, provisional", () => {
    const r = scored({
      asOf: AS_OF,
      invoices: [inv({ id: "s", status: "sent", due_date: "2026-10-15", amount_cents: 1000, amount_outstanding_cents: 1000 })],
      paidTimings: [],
    });
    expect(r.composite_score).toBe(84); // .55·70 + .30·100 + .15·100 = 83.5 → 84
    expect(r.risk_level).toBe("medium");
    expect(inputsOf(r).provisional).toBe(true);
  });
});

describe("computeClientScore v1 — insufficient data", () => {
  it("no invoices → insufficient_data", () => {
    expect(computeClientScore({ asOf: AS_OF, invoices: [], paidTimings: [] })).toEqual({ kind: "insufficient_data" });
  });
  it("only drafts → insufficient_data", () => {
    expect(
      computeClientScore({ asOf: AS_OF, invoices: [inv({ id: "d", status: "draft", amount_cents: 5000 })], paidTimings: [] }),
    ).toEqual({ kind: "insufficient_data" });
  });
  it("total billed = 0 → insufficient_data", () => {
    expect(
      computeClientScore({ asOf: AS_OF, invoices: [inv({ id: "z", status: "sent", amount_cents: 0 })], paidTimings: [] }),
    ).toEqual({ kind: "insufficient_data" });
  });
});

describe("formatCents", () => {
  it("formats cents to 2-decimal dollars with grouping", () => {
    expect(formatCents(124000)).toBe("$1,240.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });
});

describe("freshness — UTC day math in the scorer", () => {
  // asOf in the afternoon UTC proves there is no +1 day.
  const afternoon = new Date("2026-09-25T21:00:00Z");
  const overdue = (due: string) =>
    scored({
      asOf: afternoon,
      invoices: [inv({ id: "o", status: "overdue", due_date: due, amount_cents: 1000, amount_outstanding_cents: 1000 })],
      paidTimings: [],
    });

  it("exactly 90 days past due → delinquency 15", () => {
    const r = overdue("2026-06-27"); // 2026-06-27 → 2026-09-25 = 90 days
    expect(inputsOf(r).aggregates.max_days_past_due).toBe(90);
    expect(inputsOf(r).components.currentDelinquency).toBe(15);
  });

  it("91 days past due → delinquency 10", () => {
    const r = overdue("2026-06-26");
    expect(inputsOf(r).aggregates.max_days_past_due).toBe(91);
    expect(inputsOf(r).components.currentDelinquency).toBe(10);
  });

  it("the scorer output carries inputs.version === SCORER_VERSION", () => {
    expect(inputsOf(overdue("2026-09-01")).version).toBe(SCORER_VERSION);
  });
});

// Real Test-DB inputs for every client scored on 2026-09-25 (19 rows, including
// the originally verified ones). Each is recomputed at its stored as_of with the
// new UTC day math. Expected: identical composites except where a 1-day shift
// crosses a lateness boundary. Only Rondonuwu moves: 91 → 90 days (10 → 15), 42 → 43.
describe("regression — 2026-09-25 Test clients under UTC day math", () => {
  const MOVED: Record<string, number> = { "Rondonuwu Fruit and Vegi": 43 };
  type Fx = {
    name: string;
    stored_as_of: string;
    stored_composite: number;
    invoices: ScoreInvoice[];
    payments: { invoice_id: string; paid_at: string | null }[];
    balance_events: { invoice_id: string; detected_at: string; new_outstanding_cents: number; evidence: unknown }[];
  };
  const clients = (regression as unknown as { clients: Fx[] }).clients;

  it("covers all 19 scored clients", () => {
    expect(clients).toHaveLength(19);
  });

  it.each(clients.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const paidIds = c.invoices.filter((i) => i.status === "paid").map((i) => i.id);
    const r = scored({
      asOf: new Date(c.stored_as_of),
      invoices: c.invoices,
      paidTimings: resolvePaidTimings(paidIds, c.payments, c.balance_events),
    });
    expect(r.composite_score).toBe(MOVED[c.name] ?? c.stored_composite);
  });
});

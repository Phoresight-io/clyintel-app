import { describe, it, expect } from "vitest";
import {
  computeSettlements,
  feeAmountToCents,
  type EligibleLedgerRow,
} from "./computeSettlements";

const row = (
  id: string,
  subscriberId: string,
  feeAmount: number,
  cycleClose = "2026-07-15",
): EligibleLedgerRow => ({ id, subscriberId, feeAmount, cycleClose, source: "qbo" });

const BOUNDARY = "2026-08-15";

describe("feeAmountToCents (dollars → cents rounding)", () => {
  it("rounds whole-cent dollar amounts exactly", () => {
    expect(feeAmountToCents(8.58)).toBe(858);
    expect(feeAmountToCents(0.3)).toBe(30);
    expect(feeAmountToCents(0)).toBe(0);
  });

  it("rounds a fractional cent to the nearest cent (half up)", () => {
    expect(feeAmountToCents(2.005)).toBe(201); // 200.5 → 201
    expect(feeAmountToCents(2.004)).toBe(200); // 200.4 → 200
  });
});

describe("computeSettlements — totals reconcile", () => {
  it("sums per-line cents so sum(lines) === total_fee_cents", () => {
    const { billable } = computeSettlements(
      [row("l1", "subA", 3.33), row("l2", "subA", 1.11)],
      { boundary: BOUNDARY, minChargeCents: 50 },
    );
    expect(billable).toHaveLength(1);
    const plan = billable[0];
    expect(plan.lines.map((l) => l.feeCents)).toEqual([333, 111]);
    expect(plan.totalFeeCents).toBe(444);
    expect(plan.lines.reduce((s, l) => s + l.feeCents, 0)).toBe(plan.totalFeeCents);
    expect(plan.lineCount).toBe(2);
    expect(plan.cycleClose).toBe(BOUNDARY);
  });

  it("rounds PER LINE then sums (not round-of-sum)", () => {
    // Two rows of 0.014: per-line round(1.4)=1 each ⇒ total 2.
    // round-of-sum would be round(0.028*100)=round(2.8)=3 — the wrong answer.
    const { billable, carried } = computeSettlements(
      [row("l1", "subA", 0.014), row("l2", "subA", 0.014)],
      { boundary: BOUNDARY, minChargeCents: 1 },
    );
    const plan = [...billable, ...carried][0];
    expect(plan.lines.map((l) => l.feeCents)).toEqual([1, 1]);
    expect(plan.totalFeeCents).toBe(2);
  });
});

describe("computeSettlements — threshold & carry-forward", () => {
  it("sub-threshold subscriber is CARRIED (no settlement produced)", () => {
    const { billable, carried } = computeSettlements([row("l1", "subA", 0.3)], {
      boundary: BOUNDARY,
      minChargeCents: 50,
    });
    expect(billable).toHaveLength(0);
    expect(carried).toHaveLength(1);
    expect(carried[0].totalFeeCents).toBe(30);
  });

  it("a later run whose accumulated rows cross the threshold becomes ONE BILLABLE settlement absorbing the older rows", () => {
    // Run 1: only the $0.30 row exists → carried, nothing persisted, row stays
    // unlinked. Run 2: selection returns the still-unlinked $0.30 row (older
    // cycle) PLUS a new $0.40 row → 70c >= 50c ⇒ billable, both rows as lines,
    // keyed to the run boundary.
    const run2Rows = [
      row("l1", "subA", 0.3, "2026-07-15"), // older cycle, carried forward
      row("l2", "subA", 0.4, "2026-08-15"),
    ];
    const { billable, carried } = computeSettlements(run2Rows, {
      boundary: BOUNDARY,
      minChargeCents: 50,
    });
    expect(carried).toHaveLength(0);
    expect(billable).toHaveLength(1);
    expect(billable[0].totalFeeCents).toBe(70);
    expect(billable[0].lineCount).toBe(2);
    expect(billable[0].cycleClose).toBe(BOUNDARY); // absorbed under the run boundary
    expect(billable[0].lines.map((l) => l.ledgerRowId)).toEqual(["l1", "l2"]);
  });

  it("threshold is inclusive — total == minChargeCents is BILLABLE", () => {
    const { billable, carried } = computeSettlements([row("l1", "subA", 0.5)], {
      boundary: BOUNDARY,
      minChargeCents: 50,
    });
    expect(carried).toHaveLength(0);
    expect(billable).toHaveLength(1);
    expect(billable[0].totalFeeCents).toBe(50);
  });
});

describe("computeSettlements — grouping / isolation", () => {
  it("never combines different subscribers, even interleaved", () => {
    const { billable } = computeSettlements(
      [
        row("l1", "subA", 1.0),
        row("l2", "subB", 2.0),
        row("l3", "subA", 0.5),
        row("l4", "subB", 3.0),
      ],
      { boundary: BOUNDARY, minChargeCents: 50 },
    );
    expect(billable).toHaveLength(2);
    const a = billable.find((p) => p.subscriberId === "subA")!;
    const b = billable.find((p) => p.subscriberId === "subB")!;
    expect(a.totalFeeCents).toBe(150);
    expect(a.lineCount).toBe(2);
    expect(b.totalFeeCents).toBe(500);
    expect(b.lineCount).toBe(2);
  });

  it("empty input → no plans", () => {
    expect(computeSettlements([], { boundary: BOUNDARY, minChargeCents: 50 })).toEqual({
      billable: [],
      carried: [],
    });
  });
});

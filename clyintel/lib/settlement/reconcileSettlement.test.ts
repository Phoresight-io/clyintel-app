import { describe, it, expect } from "vitest";
import { reconcileSettlement } from "./reconcileSettlement";

describe("reconcileSettlement", () => {
  it("ok when line_count and sum(fee_cents) both match", () => {
    const r = reconcileSettlement({
      lineCount: 2,
      totalFeeCents: 444,
      lines: [{ feeCents: 333 }, { feeCents: 111 }],
    });
    expect(r).toEqual({ ok: true, sumFeeCents: 444, actualLineCount: 2 });
  });

  it("fails when the fee sum does not match total_fee_cents", () => {
    const r = reconcileSettlement({
      lineCount: 2,
      totalFeeCents: 500,
      lines: [{ feeCents: 333 }, { feeCents: 111 }], // sums to 444
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/total_fee_cents 500 != sum\(fee_cents\) 444/);
  });

  it("fails when line_count does not match the actual number of lines", () => {
    const r = reconcileSettlement({
      lineCount: 3,
      totalFeeCents: 444,
      lines: [{ feeCents: 333 }, { feeCents: 111 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/line_count 3 != actual lines 2/);
  });
});

import { describe, it, expect } from "vitest";
import { mostRecentClosedCycleClose } from "./cycleBoundary";

// All dates constructed via Date.UTC so the assertions don't depend on the
// runner's timezone (the helper is UTC-only).
const at = (y: number, m1: number, d: number, h = 12) => new Date(Date.UTC(y, m1 - 1, d, h));

describe("mostRecentClosedCycleClose", () => {
  it("ON the 15th → this month's 15th (today's cycle just closed)", () => {
    expect(mostRecentClosedCycleClose(at(2026, 8, 15))).toBe("2026-08-15");
  });

  it("AFTER the 15th (16th, 20th, 31st) → still THIS month's 15th, never next month", () => {
    expect(mostRecentClosedCycleClose(at(2026, 8, 16))).toBe("2026-08-15");
    expect(mostRecentClosedCycleClose(at(2026, 8, 20))).toBe("2026-08-15");
    expect(mostRecentClosedCycleClose(at(2026, 8, 31))).toBe("2026-08-15");
  });

  it("BEFORE the 15th (14th, 1st) → last month's 15th (this month's cycle hasn't closed)", () => {
    expect(mostRecentClosedCycleClose(at(2026, 8, 14))).toBe("2026-07-15");
    expect(mostRecentClosedCycleClose(at(2026, 8, 1))).toBe("2026-07-15");
  });

  it("month rollover: early January → previous December's 15th", () => {
    expect(mostRecentClosedCycleClose(at(2026, 1, 3))).toBe("2025-12-15");
  });

  it("year boundary on the 15th of January → January 15th", () => {
    expect(mostRecentClosedCycleClose(at(2026, 1, 15))).toBe("2026-01-15");
  });

  it("uses UTC, not local time (late-UTC-14th is still before the 15th)", () => {
    // 2026-08-14T23:30Z → day 14 in UTC → last month's 15th.
    expect(mostRecentClosedCycleClose(new Date("2026-08-14T23:30:00Z"))).toBe("2026-07-15");
  });
});

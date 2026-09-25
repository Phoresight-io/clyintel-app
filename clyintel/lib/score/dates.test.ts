import { describe, it, expect } from "vitest";
import { daysBetweenUtcDates, utcYmd } from "./dates";
import { daysFromToday } from "../adapters";

describe("daysBetweenUtcDates — whole UTC calendar days, no rounding", () => {
  it("due 2026-06-28, asOf 2026-09-25T21:00Z → 89 (live off-by-one case; old math gave 90)", () => {
    expect(daysBetweenUtcDates("2026-06-28", new Date("2026-09-25T21:00:00Z"))).toBe(89);
  });

  it("same asOf date at 00:00Z and 23:59Z → 89", () => {
    expect(daysBetweenUtcDates("2026-06-28", new Date("2026-09-25T00:00:00Z"))).toBe(89);
    expect(daysBetweenUtcDates("2026-06-28", new Date("2026-09-25T23:59:59.999Z"))).toBe(89);
  });

  it("due today → 0; due tomorrow → -1", () => {
    const asOf = new Date("2026-09-25T18:30:00Z");
    expect(daysBetweenUtcDates("2026-09-25", asOf)).toBe(0);
    expect(daysBetweenUtcDates("2026-09-26", asOf)).toBe(-1);
  });

  it("always an exact integer; date strings on both sides; invalid → null", () => {
    expect(Number.isInteger(daysBetweenUtcDates("2026-01-31", new Date("2026-03-01T13:07:00Z")))).toBe(true);
    expect(daysBetweenUtcDates("2026-06-01", "2026-07-21")).toBe(50);
    expect(daysBetweenUtcDates("not-a-date", new Date())).toBeNull();
  });

  it("utcYmd uses the UTC calendar date", () => {
    expect(utcYmd(new Date("2026-09-25T23:59:59Z"))).toBe("2026-09-25");
  });
});

describe("daysFromToday (UI 'Due In' + uiStatus) routes through the same helper", () => {
  const afternoon = new Date("2026-09-25T21:00:00Z");
  it("past due in the afternoon is not +1", () => {
    expect(daysFromToday("2026-06-28", afternoon)).toBe(-89);
  });
  it("due today stays 0 (not past due) in the afternoon; tomorrow → 1", () => {
    expect(daysFromToday("2026-09-25", afternoon)).toBe(0);
    expect(Object.is(daysFromToday("2026-09-25", afternoon), -0)).toBe(false);
    expect(daysFromToday("2026-09-26", afternoon)).toBe(1);
  });
});

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

describe("utcYmd — UTC date, boundaries", () => {
  it("uses the UTC date, not the local date, for offset instants", () => {
    expect(utcYmd(new Date("2026-01-01T05:00:00+14:00"))).toBe("2025-12-31");
  });
  it("leap day", () => {
    expect(utcYmd(new Date("2024-02-29T12:00:00Z"))).toBe("2024-02-29");
  });
  it("Invalid Date throws RangeError (current contract)", () => {
    expect(() => utcYmd(new Date("invalid"))).toThrow(RangeError);
  });
});

describe("daysBetweenUtcDates — boundaries and invalid input", () => {
  it("year boundary", () => {
    expect(daysBetweenUtcDates("2025-12-31", new Date("2026-01-01T00:00:00Z"))).toBe(1);
  });
  it("leap and non-leap years", () => {
    expect(daysBetweenUtcDates("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetweenUtcDates("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetweenUtcDates("2024-01-01", "2025-01-01")).toBe(366);
    expect(daysBetweenUtcDates("2026-01-01", "2027-01-01")).toBe(365);
  });
  it("across US DST start is an exact integer", () => {
    const n = daysBetweenUtcDates("2026-03-07", "2026-03-09");
    expect(n).toBe(2);
    expect(Number.isInteger(n)).toBe(true);
  });
  it("time suffix on fromYmd is ignored", () => {
    expect(daysBetweenUtcDates("2026-06-28T23:59:59Z", new Date("2026-09-25T00:00:00Z"))).toBe(89);
  });
  it("asOf before from is negative", () => {
    expect(daysBetweenUtcDates("2026-09-30", new Date("2026-09-25T12:00:00Z"))).toBe(-5);
  });
  it("invalid input → null", () => {
    expect(daysBetweenUtcDates("2026-06-28", new Date("invalid"))).toBeNull();
    expect(daysBetweenUtcDates("2026-06-28", "garbage")).toBeNull();
    expect(daysBetweenUtcDates("", new Date("2026-09-25T00:00:00Z"))).toBeNull();
  });
});

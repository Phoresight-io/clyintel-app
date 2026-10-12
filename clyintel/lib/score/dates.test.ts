import { describe, it, expect, vi, afterEach } from "vitest";
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

describe("utcYmd — edge cases", () => {
  it("start and end of a UTC day", () => {
    expect(utcYmd(new Date("2026-09-25T00:00:00Z"))).toBe("2026-09-25");
    expect(utcYmd(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-31");
  });
  it("uses the UTC date even when the instant has an offset", () => {
    expect(utcYmd(new Date("2026-09-25T20:00:00-05:00"))).toBe("2026-09-26");
  });
  it("invalid Date throws RangeError (documents current behavior: no guard)", () => {
    expect(() => utcYmd(new Date("invalid"))).toThrow(RangeError);
  });
});

describe("daysBetweenUtcDates — edge cases", () => {
  it("crosses month / leap day", () => {
    expect(daysBetweenUtcDates("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetweenUtcDates("2026-02-28", "2026-03-01")).toBe(1);
  });
  it("crosses a year", () => {
    expect(daysBetweenUtcDates("2025-12-31", new Date("2026-01-01T00:00:00Z"))).toBe(1);
  });
  it("US DST transitions do not change the count", () => {
    expect(daysBetweenUtcDates("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetweenUtcDates("2026-10-31", "2026-11-02")).toBe(2);
  });
  it("a full timestamp as fromYmd uses only its date part", () => {
    expect(daysBetweenUtcDates("2026-06-28T23:59:59Z", new Date("2026-06-29T00:00:00Z"))).toBe(1);
  });
  it("invalid input on either side → null; future dates are negative", () => {
    expect(daysBetweenUtcDates("", "2026-09-25")).toBeNull();
    expect(daysBetweenUtcDates("2026-09-25", "not-a-date")).toBeNull();
    expect(daysBetweenUtcDates("2026-09-25", new Date(NaN))).toBeNull();
    expect(daysBetweenUtcDates("2026-10-01", "2026-09-25")).toBe(-6);
  });
});

describe("daysFromToday — edge cases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const start = new Date("2026-09-25T00:00:00Z");
  const end = new Date("2026-09-25T23:59:59.999Z");
  it("null / empty / garbage → null", () => {
    expect(daysFromToday(null, start)).toBeNull();
    expect(daysFromToday("", start)).toBeNull();
    expect(daysFromToday("garbage", start)).toBeNull();
  });
  it("same result at start and end of the UTC day", () => {
    expect(daysFromToday("2026-10-05", start)).toBe(10);
    expect(daysFromToday("2026-10-05", end)).toBe(10);
  });
  it("defaults now to the current clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    expect(daysFromToday("2026-09-26")).toBe(1);
  });
});

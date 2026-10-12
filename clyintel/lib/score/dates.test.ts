import { describe, it, expect, afterEach } from "vitest";
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

const ORIGINAL_TZ = process.env.TZ;
const HOSTILE_TZS = ["America/Los_Angeles", "Pacific/Kiritimati"];

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("utcYmd — edge cases", () => {
  it("non-UTC offset instant crossing midnight uses the UTC date", () => {
    expect(utcYmd(new Date("2026-09-25T23:30:00-05:00"))).toBe("2026-09-26");
  });

  it("year boundary", () => {
    expect(utcYmd(new Date("2025-12-31T23:59:59.999Z"))).toBe("2025-12-31");
    expect(utcYmd(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it.each(HOSTILE_TZS)("is timezone independent under TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(utcYmd(new Date("2026-09-25T23:30:00-05:00"))).toBe("2026-09-26");
    expect(utcYmd(new Date("2025-12-31T23:59:59.999Z"))).toBe("2025-12-31");
    expect(utcYmd(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});

describe("daysBetweenUtcDates — edge cases", () => {
  it("year boundary", () => {
    expect(daysBetweenUtcDates("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("leap and non-leap February", () => {
    expect(daysBetweenUtcDates("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetweenUtcDates("2026-02-28", "2026-03-01")).toBe(1);
  });

  it("DST weeks give exact integers, also under America/Los_Angeles", () => {
    for (const tz of [undefined, "America/Los_Angeles"]) {
      if (tz) process.env.TZ = tz;
      expect(daysBetweenUtcDates("2026-03-07", "2026-03-09")).toBe(2);
      expect(daysBetweenUtcDates("2026-10-31", "2026-11-02")).toBe(2);
    }
  });

  it("strings use the leading YMD (offset ignored); Dates use the UTC date", () => {
    expect(daysBetweenUtcDates("2026-09-25", "2026-09-25T23:30:00-05:00")).toBe(0);
    expect(daysBetweenUtcDates("2026-09-25", new Date("2026-09-25T23:30:00-05:00"))).toBe(1);
  });

  it("invalid inputs → null", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    expect(daysBetweenUtcDates("", now)).toBeNull();
    expect(daysBetweenUtcDates("2026-06-01", new Date("invalid"))).toBeNull();
    expect(daysBetweenUtcDates("2026-06-01", "garbage")).toBeNull();
  });

  it("day-boundary instants", () => {
    expect(daysBetweenUtcDates("2026-09-25", new Date("2026-09-25T23:59:59.999Z"))).toBe(0);
    expect(daysBetweenUtcDates("2026-09-25", new Date("2026-09-26T00:00:00.000Z"))).toBe(1);
  });

  it.each(HOSTILE_TZS)("is timezone independent under TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(daysBetweenUtcDates("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetweenUtcDates("2026-06-28", new Date("2026-09-25T21:00:00Z"))).toBe(89);
  });
});

describe("daysFromToday — edge cases", () => {
  it("null, empty and garbage → null", () => {
    expect(daysFromToday(null)).toBeNull();
    expect(daysFromToday("")).toBeNull();
    expect(daysFromToday("garbage")).toBeNull();
  });

  it("future date across a month boundary", () => {
    expect(daysFromToday("2026-10-01", new Date("2026-09-30T23:59:59Z"))).toBe(1);
  });
});

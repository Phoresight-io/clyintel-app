import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// Pins process.env.TZ for the enclosing describe and restores it afterwards.
function useTZ(tz: string) {
  let original: string | undefined;
  beforeAll(() => {
    original = process.env.TZ;
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
}

const OFFSET_ZONES: Array<[string, boolean]> = [
  ["America/Los_Angeles", true],
  ["Pacific/Kiritimati", true],
  ["UTC", false],
];

describe("date formatting: utcYmd", () => {
  it("returns the UTC calendar date and handles the midnight boundary", () => {
    expect(utcYmd(new Date("2026-09-25T00:00:00.000Z"))).toBe("2026-09-25");
    expect(utcYmd(new Date("2026-09-25T23:59:59.999Z"))).toBe("2026-09-25");
    expect(utcYmd(new Date("2026-09-26T00:00:00.000Z"))).toBe("2026-09-26");
  });
  it("uses the UTC date, not the wall date, for offset input", () => {
    expect(utcYmd(new Date("2026-09-25T20:00:00-05:00"))).toBe("2026-09-26");
  });
  it("handles leap day and year end", () => {
    expect(utcYmd(new Date("2028-02-29T12:00:00Z"))).toBe("2028-02-29");
    expect(utcYmd(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });
  it("throws RangeError for an Invalid Date (toISOString throws)", () => {
    expect(() => utcYmd(new Date("x"))).toThrow(RangeError);
  });
  describe.each(OFFSET_ZONES)("TZ %s", (tz, nonUtc) => {
    useTZ(tz);
    it("host offset switch took effect", () => {
      const off = new Date("2026-06-03T00:00:00Z").getTimezoneOffset();
      if (nonUtc) expect(off).not.toBe(0);
      else expect(off).toBe(0);
    });
    it("gives the same results as in any other zone", () => {
      expect(utcYmd(new Date("2026-09-25T00:00:00.000Z"))).toBe("2026-09-25");
      expect(utcYmd(new Date("2026-09-25T23:59:59.999Z"))).toBe("2026-09-25");
      expect(utcYmd(new Date("2026-09-26T00:00:00.000Z"))).toBe("2026-09-26");
      expect(utcYmd(new Date("2026-09-25T20:00:00-05:00"))).toBe("2026-09-26");
      expect(utcYmd(new Date("2028-02-29T12:00:00Z"))).toBe("2028-02-29");
      expect(utcYmd(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
    });
  });
});

describe("date formatting: daysBetweenUtcDates", () => {
  const NOW = new Date("2026-09-25T21:00:00Z");
  it("is negative when asOf is earlier", () => {
    expect(daysBetweenUtcDates("2026-09-26", "2026-09-25")).toBe(-1);
  });
  it("handles leap and non-leap February", () => {
    expect(daysBetweenUtcDates("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetweenUtcDates("2026-02-28", "2026-03-01")).toBe(1);
  });
  it("crosses the year boundary", () => {
    expect(daysBetweenUtcDates("2026-12-31", "2027-01-01")).toBe(1);
  });
  describe("under America/New_York (DST)", () => {
    useTZ("America/New_York");
    it("host offset switch took effect", () => {
      expect(new Date("2026-06-03T00:00:00Z").getTimezoneOffset()).not.toBe(0);
    });
    it("spring forward 2026-03-08 still counts whole days", () => {
      const r = daysBetweenUtcDates("2026-03-07", "2026-03-09");
      expect(r).toBe(2);
      expect(Number.isInteger(r)).toBe(true);
    });
    it("fall back 2026-11-01 still counts whole days", () => {
      const r = daysBetweenUtcDates("2026-10-31", "2026-11-02");
      expect(r).toBe(2);
      expect(Number.isInteger(r)).toBe(true);
    });
  });
  it("accepts a full timestamp as fromYmd", () => {
    expect(daysBetweenUtcDates("2026-06-28T23:59:59Z", NOW)).toBe(89);
  });
  it("uses the YMD prefix of fromYmd and ignores its offset (current behaviour)", () => {
    expect(daysBetweenUtcDates("2026-06-28T23:00:00-05:00", NOW)).toBe(89);
  });
  it("accepts a non-YMD parseable asOf string", () => {
    expect(daysBetweenUtcDates("2026-06-28", "Fri, 25 Sep 2026 21:00:00 GMT")).toBe(89);
  });
  it("returns null for invalid input", () => {
    expect(daysBetweenUtcDates("", NOW)).toBeNull();
    expect(daysBetweenUtcDates("2026-06-28", new Date(NaN))).toBeNull();
    expect(daysBetweenUtcDates("2026-06-28", "garbage")).toBeNull();
  });
  describe.each(OFFSET_ZONES.slice(0, 2))("TZ %s", (tz) => {
    useTZ(tz);
    it("host offset switch took effect", () => {
      expect(new Date("2026-06-03T00:00:00Z").getTimezoneOffset()).not.toBe(0);
    });
    it("89-day case is timezone independent", () => {
      expect(daysBetweenUtcDates("2026-06-28", NOW)).toBe(89);
    });
  });
  it.todo("rejects out-of-range YMD such as 2026-02-30 / 2026-13-01 (currently rolls over via Date.UTC)");
  it.todo("returns null for a runtime null fromYmd (currently new Date(null) = epoch → huge positive count)");
});

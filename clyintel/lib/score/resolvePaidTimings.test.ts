import { describe, it, expect, afterEach } from "vitest";
import { resolvePaidTimings, utcDate } from "./resolvePaidTimings";

describe("resolvePaidTimings — precedence", () => {
  it("payments win over balance_events; the LAST succeeded payment's date is used", () => {
    const out = resolvePaidTimings(
      ["a"],
      [
        { invoice_id: "a", paid_at: "2026-07-01T10:00:00+00:00" },
        { invoice_id: "a", paid_at: "2026-07-28T23:30:00+00:00" },
        { invoice_id: "a", paid_at: null },
      ],
      [{ invoice_id: "a", detected_at: "2026-06-01T00:00:00Z", new_outstanding_cents: 0, evidence: null }],
    );
    expect(out).toEqual([{ invoice_id: "a", paid_date: "2026-07-28", date_source: "payment" }]);
  });

  it("balance_events: FIRST zero-balance event by detected_at; evidence.txnDate → qbo_txn", () => {
    const out = resolvePaidTimings(
      ["b"],
      [],
      [
        { invoice_id: "b", detected_at: "2026-08-20T00:00:00Z", new_outstanding_cents: 0, evidence: { txnDate: "2026-08-18" } },
        { invoice_id: "b", detected_at: "2026-08-10T00:00:00Z", new_outstanding_cents: 0, evidence: { txnDate: "2026-08-09" } },
        { invoice_id: "b", detected_at: "2026-08-01T00:00:00Z", new_outstanding_cents: 500, evidence: null },
      ],
    );
    expect(out).toEqual([{ invoice_id: "b", paid_date: "2026-08-09", date_source: "qbo_txn" }]);
  });

  it("no txnDate in evidence → detected_at → detected", () => {
    const out = resolvePaidTimings(
      ["c"],
      [],
      [{ invoice_id: "c", detected_at: "2026-08-10T15:00:00Z", new_outstanding_cents: 0, evidence: { syncedAt: "x" } }],
    );
    expect(out).toEqual([{ invoice_id: "c", paid_date: "2026-08-10", date_source: "detected" }]);
  });

  it("neither source → no record (paid, undated); non-paid ids never appear", () => {
    const out = resolvePaidTimings(
      ["d"],
      [{ invoice_id: "zz", paid_at: "2026-08-01T00:00:00Z" }],
      [{ invoice_id: "d", detected_at: "2026-08-01T00:00:00Z", new_outstanding_cents: 100, evidence: null }],
    );
    expect(out).toEqual([]);
  });

  it("one record per invoice, sorted by id", () => {
    const out = resolvePaidTimings(
      ["b", "a", "a"],
      [{ invoice_id: "a", paid_at: "2026-07-01T00:00:00Z" }],
      [{ invoice_id: "b", detected_at: "2026-07-02T00:00:00Z", new_outstanding_cents: 0, evidence: null }],
    );
    expect(out.map((t) => t.invoice_id)).toEqual(["a", "b"]);
  });
});

describe("utcDate", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("date-only string passes through; offset timestamps convert to UTC", () => {
    expect(utcDate("2026-06-03")).toBe("2026-06-03");
    expect(utcDate("2026-06-03T23:30:00-05:00")).toBe("2026-06-04");
  });

  it("non-string or empty → null", () => {
    for (const v of [null, undefined, "", 20260603, {}, new Date()]) {
      expect(utcDate(v)).toBeNull();
    }
  });

  it("unparseable string → null", () => {
    expect(utcDate("garbage")).toBeNull();
  });

  it("is timezone independent under America/Los_Angeles", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(utcDate("2026-06-03")).toBe("2026-06-03");
    expect(utcDate("2026-06-03T23:30:00-05:00")).toBe("2026-06-04");
  });
});

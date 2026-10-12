import { describe, it, expect } from "vitest";
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
  it("converts offset instants to the UTC date", () => {
    expect(utcDate("2026-09-25T23:30:00-05:00")).toBe("2026-09-26");
  });
  it("date-only string parses as UTC", () => {
    expect(utcDate("2026-09-25")).toBe("2026-09-25");
  });
  it("year-end and leap-day boundaries", () => {
    expect(utcDate("2025-12-31T23:59:59.999Z")).toBe("2025-12-31");
    expect(utcDate("2024-02-29T00:00:00Z")).toBe("2024-02-29");
  });
  it("non-string → null", () => {
    for (const v of [null, undefined, 1727222400000, new Date(), {}]) {
      expect(utcDate(v)).toBeNull();
    }
  });
  it("empty / unparseable string → null", () => {
    expect(utcDate("")).toBeNull();
    expect(utcDate("garbage")).toBeNull();
  });
});

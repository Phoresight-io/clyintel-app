import { describe, it, expect } from "vitest";
import { isOutreachBeforePayment } from "./outreachBeforePayment";

const CREATE = "2026-09-23T04:41:37.000Z"; // payment recorded in QBO
const TXN = "2026-09-23"; // payment TxnDate

describe("isOutreachBeforePayment — CreateTime (strict instant compare)", () => {
  it("outreach 1s before CreateTime → true", () => {
    expect(isOutreachBeforePayment("2026-09-23T04:41:36.000Z", CREATE, TXN)).toBe(true);
  });
  it("outreach EQUAL to CreateTime → false (not before)", () => {
    expect(isOutreachBeforePayment(CREATE, CREATE, TXN)).toBe(false);
  });
  it("outreach after CreateTime → false", () => {
    expect(isOutreachBeforePayment("2026-09-23T04:41:38.000Z", CREATE, TXN)).toBe(false);
  });
  it("CreateTime wins over TxnDate: same UTC day but earlier instant → true", () => {
    expect(isOutreachBeforePayment("2026-09-23T01:00:00.000Z", CREATE, TXN)).toBe(true);
  });
  it("CreateTime with a QBO offset is compared as an instant", () => {
    // 21:41:37-07:00 == 04:41:37Z next day
    expect(isOutreachBeforePayment("2026-09-23T04:41:36Z", "2026-09-22T21:41:37-07:00", null)).toBe(true);
    expect(isOutreachBeforePayment("2026-09-23T04:41:38Z", "2026-09-22T21:41:37-07:00", null)).toBe(false);
  });
});

describe("isOutreachBeforePayment — fail closed", () => {
  it("null outreach → false", () => {
    expect(isOutreachBeforePayment(null, CREATE, TXN)).toBe(false);
  });
  it("malformed outreach marker → false", () => {
    expect(isOutreachBeforePayment("garbage", CREATE, TXN)).toBe(false);
  });
  it("both payment values null → false", () => {
    expect(isOutreachBeforePayment("2020-01-01T00:00:00.000Z", null, null)).toBe(false);
  });
  it("both payment values malformed → false", () => {
    expect(isOutreachBeforePayment("2020-01-01T00:00:00.000Z", "nope", "also-nope")).toBe(false);
  });
});

describe("isOutreachBeforePayment — TxnDate fallback (UTC dates, strict)", () => {
  it("no CreateTime + outreach on an earlier UTC date → true", () => {
    expect(isOutreachBeforePayment("2026-09-22T23:59:59.000Z", null, TXN)).toBe(true);
  });
  it("no CreateTime + outreach on the SAME UTC date → false", () => {
    expect(isOutreachBeforePayment("2026-09-23T00:00:01.000Z", null, TXN)).toBe(false);
  });
  it("no CreateTime + outreach on a later UTC date → false", () => {
    expect(isOutreachBeforePayment("2026-09-24T00:00:00.000Z", null, TXN)).toBe(false);
  });
  it("TxnDate given as the adapter's ISO midnight (event.capturedAt) behaves the same", () => {
    expect(isOutreachBeforePayment("2026-09-22T12:00:00.000Z", null, "2026-09-23T00:00:00.000Z")).toBe(true);
    expect(isOutreachBeforePayment("2026-09-23T12:00:00.000Z", null, "2026-09-23T00:00:00.000Z")).toBe(false);
  });
  it("malformed CreateTime → falls back to TxnDate", () => {
    expect(isOutreachBeforePayment("2026-09-22T12:00:00.000Z", "not-a-time", TXN)).toBe(true);
    expect(isOutreachBeforePayment("2026-09-23T03:00:00.000Z", "not-a-time", TXN)).toBe(false);
  });
  it("empty-string CreateTime is treated as absent → TxnDate fallback", () => {
    expect(isOutreachBeforePayment("2026-09-22T12:00:00.000Z", "", TXN)).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { aggregateRecoveryYTD, type RecoveryLedgerRow, type RecoveryInvoiceRef } from "./recoveryYTD";

const NOW = new Date("2026-09-26T12:00:00Z");

const row = (id: string, source_invoice_id: string | null, dollars: number | string, captured_at = "2026-09-13T00:00:00Z"): RecoveryLedgerRow => ({
  id,
  source_invoice_id,
  dollars_recovered: dollars,
  captured_at,
});

// Mirrors Test subscriber 34205047-…: four credited recoveries across qbo + stripe_recovery.
const INVOICES: RecoveryInvoiceRef[] = [
  { external_id: "145", client_id: "client-a" },
  { external_id: "49", client_id: "client-b" },
  { external_id: "103", client_id: "client-c" },
  { external_id: "129", client_id: "client-d" },
  { external_id: null, client_id: "client-e" },
];

describe("aggregateRecoveryYTD", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("sums across sources to the cent, attributing each row to its client", () => {
    const rows = [
      row("l1", "145", 3900.0, "2026-08-04T02:44:25Z"), // stripe_recovery
      row("l2", "49", "954.75"), // qbo (numeric may arrive as string)
      row("l3", "103", 629.1),
      row("l4", "129", 207.5, "2026-09-23T00:00:00Z"),
    ];
    expect(aggregateRecoveryYTD(rows, INVOICES, NOW)).toEqual({
      ok: true,
      totalCents: 569135,
      byClientCents: { "client-a": 390000, "client-b": 95475, "client-c": 62910, "client-d": 20750 },
    });
  });

  it("excludes rows before Jan 1 UTC and includes the exact 00:00:00Z boundary", () => {
    const rows = [
      row("before", "145", 100, "2025-12-31T23:59:59.999Z"),
      row("boundary", "49", 10, "2026-01-01T00:00:00Z"),
    ];
    expect(aggregateRecoveryYTD(rows, INVOICES, NOW)).toEqual({
      ok: true,
      totalCents: 1000,
      byClientCents: { "client-b": 1000 },
    });
  });

  it("keeps cents precision (954.75 + 629.10 + 207.50 + 3900.00 = 569135)", () => {
    const rows = [row("a", "49", 954.75), row("b", "103", 629.1), row("c", "129", 207.5), row("d", "145", 3900)];
    const r = aggregateRecoveryYTD(rows, INVOICES, NOW);
    expect(r.ok && r.totalCents).toBe(569135);
  });

  it("counts an unmatched row in the total but not in any client, and warns with the ledger id", () => {
    const r = aggregateRecoveryYTD([row("l1", "49", 10), row("orphan", "999", 5), row("nullref", null, 1)], INVOICES, NOW);
    expect(r).toEqual({ ok: true, totalCents: 1600, byClientCents: { "client-b": 1000 } });
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), "orphan");
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), "nullref");
  });

  it("counts a row whose external_id is duplicated in the total but attributes it to no client", () => {
    const invoices = [...INVOICES, { external_id: "49", client_id: "client-z" }];
    const r = aggregateRecoveryYTD([row("dup", "49", 12.34), row("ok", "103", 1)], invoices, NOW);
    expect(r).toEqual({ ok: true, totalCents: 1334, byClientCents: { "client-c": 100 } });
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), "dup");
  });

  it("empty rows → ok with total 0", () => {
    expect(aggregateRecoveryYTD([], INVOICES, NOW)).toEqual({ ok: true, totalCents: 0, byClientCents: {} });
  });

  it("fails closed on a non-numeric amount", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(aggregateRecoveryYTD([row("bad", "49", "abc")], INVOICES, NOW)).toEqual({ ok: false });
  });
});

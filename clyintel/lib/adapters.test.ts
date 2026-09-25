import { describe, it, expect } from "vitest";
import { toUIClient, toUIInvoice, toUIClientInvoiceSet } from "./adapters";
import type { Database } from "@/types/supabase";

type ClientRow = Database["public"]["Tables"]["clients"]["Row"];
type PtrScoreRow = Database["public"]["Tables"]["ptr_scores"]["Row"];
type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];

const client = { id: "c1", name: "Acme", company: "Acme Co", updated_at: "2026-09-01T00:00:00Z" } as unknown as ClientRow;

function ptr(p: Partial<PtrScoreRow>): PtrScoreRow {
  return {
    composite_score: 72,
    score_summary: ["Pays, but often late", "Based on 4 invoices since May 2026"],
    score_factors: ["1 of 3 paid invoices were late", "No invoices past due"],
    risk_drivers: ["Paid 1 of 3 invoices after the due date"],
    risk_level: "medium",
    ...p,
  } as PtrScoreRow;
}

describe("toUIClient — Client Score mapping", () => {
  it("no ptr_scores row → score null (not 0), prevScore null, empty lists", () => {
    const c = toUIClient(client, { latest: null, prior: null }, []);
    expect(c.score).toBeNull();
    expect(c.prevScore).toBeNull();
    expect(c.scoreSummary).toEqual([]);
    expect(c.scoreFactors).toEqual([]);
    expect(c.riskDrivers).toEqual([]);
  });

  it("row with null composite → score null", () => {
    expect(toUIClient(client, { latest: ptr({ composite_score: null }), prior: null }, []).score).toBeNull();
  });

  it("scored, no prior → prevScore null; lists map from the array columns", () => {
    const c = toUIClient(client, { latest: ptr({}), prior: null }, []);
    expect(c.score).toBe(72);
    expect(c.prevScore).toBeNull();
    expect(c.scoreSummary).toEqual(["Pays, but often late", "Based on 4 invoices since May 2026"]);
    expect(c.scoreFactors).toEqual(["1 of 3 paid invoices were late", "No invoices past due"]);
    expect(c.riskDrivers).toEqual(["Paid 1 of 3 invoices after the due date"]);
    expect(c.provisional).toBe(false);
  });

  it("provisional comes from latest.inputs.provisional (default false)", () => {
    expect(toUIClient(client, { latest: ptr({ inputs: { provisional: true } }), prior: null }, []).provisional).toBe(true);
    expect(toUIClient(client, { latest: ptr({ inputs: { provisional: false } }), prior: null }, []).provisional).toBe(false);
    expect(toUIClient(client, { latest: ptr({ inputs: null }), prior: null }, []).provisional).toBe(false);
    expect(toUIClient(client, { latest: null, prior: null }, []).provisional).toBe(false);
  });

  it("prior row → prevScore from prior composite", () => {
    const c = toUIClient(client, { latest: ptr({}), prior: ptr({ composite_score: 65 }) }, []);
    expect(c.prevScore).toBe(65);
  });

  it("null array columns (pre-migration rows) → []", () => {
    const c = toUIClient(client, { latest: ptr({ score_summary: null, score_factors: null, risk_drivers: null }), prior: null }, []);
    expect(c.scoreSummary).toEqual([]);
    expect(c.scoreFactors).toEqual([]);
    expect(c.riskDrivers).toEqual([]);
  });
});

describe("Paid-date column — never updated_at", () => {
  const paidRow = {
    id: "inv-1",
    invoice_number: "1001",
    status: "paid",
    due_date: "2026-06-01",
    amount_cents: 10000,
    amount_outstanding_cents: 0,
    last_reminder_at: null,
    updated_at: "2026-09-20T15:00:00Z", // QBO sync touch — must never be shown
  } as unknown as InvoiceRow;

  it("map present → shows the paid date", () => {
    expect(toUIInvoice(paidRow, new Map([["inv-1", "2026-06-03"]])).paidDate).toBe("6/3/26");
  });

  it("map absent → —", () => {
    expect(toUIInvoice(paidRow).paidDate).toBe("—");
  });

  it("invoice missing from map → —", () => {
    expect(toUIInvoice(paidRow, new Map([["other", "2026-06-03"]])).paidDate).toBe("—");
  });

  it("toUIClientInvoiceSet threads the map through; never 9/20/26", () => {
    const withMap = toUIClientInvoiceSet([paidRow], new Map([["inv-1", "2026-06-03"]]));
    expect(withMap.paid[0].paidDate).toBe("6/3/26");
    const without = toUIClientInvoiceSet([paidRow]);
    expect(without.paid[0].paidDate).toBe("—");
    expect(JSON.stringify([withMap, without])).not.toContain("9/20/26");
  });
});

// Characterization test of CURRENT behavior of the invoice table date formatter
// (formatDate in ./adapters, reached through toUIInvoice / toUIClient) under
// TZ=America/New_York.
//
// NOTE: date-only strings ("YYYY-MM-DD") are parsed as UTC midnight and formatted
// with local getters, so they render as the previous day in New York. That is
// suspected to be a bug (compare the paidDate "6/3/26" expectation in
// ./adapters.test.ts, which only passes on hosts at or east of UTC). It is pinned
// here as current behavior; update this file together with any fix.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toUIClient, toUIInvoice } from "./adapters";
import type { Database } from "@/types/supabase";

type ClientRow = Database["public"]["Tables"]["clients"]["Row"];
type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];

const originalTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function inv(p: Record<string, unknown> = {}): InvoiceRow {
  return {
    id: "inv-1",
    invoice_number: "1001",
    status: "sent",
    due_date: "2026-06-01",
    amount_cents: 10000,
    amount_outstanding_cents: 10000,
    last_reminder_at: null,
    updated_at: "2026-09-20T15:00:00Z",
    ...p,
  } as unknown as InvoiceRow;
}

const due = (d: string | null) => toUIInvoice(inv({ due_date: d })).dueDate;
const activity = (t: string | null) => toUIInvoice(inv({ last_reminder_at: t })).lastActivity;

describe("timezone guard", () => {
  it("TZ=America/New_York is in effect", () => {
    const d = new Date("2026-03-01T00:00:00Z");
    expect(d.getDate()).toBe(28);
    expect(d.getTimezoneOffset()).toBe(300);
  });
});

describe("date-only strings (previous day)", () => {
  it("A1: due 2026-03-01 shows the previous day", () => expect(due("2026-03-01")).toBe("2/28/26"));
  it("A2: summer (EDT)", () => expect(due("2026-07-04")).toBe("7/3/26"));
  it("A3: DST start day", () => expect(due("2026-03-08")).toBe("3/7/26"));
  it("A4: DST end day", () => expect(due("2026-11-01")).toBe("10/31/26"));
  it("A5: year boundary", () => expect(due("2026-01-01")).toBe("12/31/25"));
  it("A6: paid date shows the previous day", () => {
    const paid = inv({ status: "paid", amount_outstanding_cents: 0 });
    expect(toUIInvoice(paid, new Map([["inv-1", "2026-06-03"]])).paidDate).toBe("6/2/26");
  });
});

describe("timestamps", () => {
  it("B1: same local day", () => expect(activity("2026-09-20T15:00:00Z")).toBe("9/20/26"));
  it("B2: 23:30 EDT previous day", () => expect(activity("2026-09-20T03:30:00Z")).toBe("9/19/26"));
  it("B3: exactly local midnight", () => expect(activity("2026-09-20T04:00:00Z")).toBe("9/20/26"));
  it("B4: client updated_at, previous local evening", () => {
    const c = { id: "c1", name: "Acme", company: "Acme Co", updated_at: "2026-09-01T00:00:00Z" } as unknown as ClientRow;
    expect(toUIClient(c, { latest: null, prior: null }, []).lastActivity).toBe("8/31/26");
  });
});

describe("empty/invalid", () => {
  it("C1: null due date", () => expect(due(null)).toBe("—"));
  it("C2: null last reminder", () => expect(activity(null)).toBe("—"));
  it("C3: invalid date", () => expect(due("not-a-date")).toBe("—"));
  it("C4: paid map missing the id", () => {
    const paid = inv({ status: "paid", amount_outstanding_cents: 0 });
    expect(toUIInvoice(paid, new Map([["other", "2026-06-03"]])).paidDate).toBe("—");
  });
});

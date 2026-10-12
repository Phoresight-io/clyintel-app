import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { toUIClient, toUIInvoice, toUIClientInvoiceSet, deriveStatus, daysFromToday } from "./adapters";
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

describe("deriveStatus — client status roll-up", () => {
  const NOW = new Date("2026-09-25T21:00:00Z");
  const invRow = (status: string, due: string | null) =>
    ({ id: `${status}-${due}`, status, due_date: due, amount_cents: 1000, amount_outstanding_cents: 1000 }) as unknown as InvoiceRow;

  it("a past-due invoice present → past_due", () => {
    expect(deriveStatus([invRow("paid", "2026-06-01"), invRow("overdue", "2026-08-01")], NOW)).toBe("past_due");
    expect(deriveStatus([invRow("partial", "2026-09-20")], NOW)).toBe("past_due"); // partial, past its due date
  });

  it(">= 1 invoice, none past due, all paid → current (was 'recovered' / \"Paid\")", () => {
    expect(deriveStatus([invRow("paid", "2026-06-01"), invRow("paid", "2026-07-01")], NOW)).toBe("current");
  });

  it(">= 1 invoice, open but not yet due (> 7 days) → current", () => {
    expect(deriveStatus([invRow("sent", "2026-10-20"), invRow("paid", "2026-06-01")], NOW)).toBe("current");
  });

  it("open invoice due within 7 days → due (kept for the Receivables dashboard)", () => {
    expect(deriveStatus([invRow("sent", "2026-10-01")], NOW)).toBe("due");
    expect(deriveStatus([invRow("sent", "2026-09-25")], NOW)).toBe("due"); // due today, not past due
  });

  it("zero invoices → no_history (was \"Current\")", () => {
    expect(deriveStatus([], NOW)).toBe("no_history");
  });

  it("toUIClient carries the derived status", () => {
    expect(toUIClient(client, { latest: null, prior: null }, []).status).toBe("no_history");
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

describe("date formatting: formatDate (via toUIInvoice/toUIClient)", () => {
  useTZ("UTC");
  const inv = (p: Record<string, unknown>) =>
    ({
      id: "inv-1",
      status: "sent",
      amount_cents: 10000,
      amount_outstanding_cents: 10000,
      last_reminder_at: null,
      due_date: "2026-06-03",
      ...p,
    }) as unknown as InvoiceRow;

  it("host offset is UTC for this block", () => {
    expect(new Date("2026-06-03T00:00:00Z").getTimezoneOffset()).toBe(0);
  });
  it("formats as M/D/YY", () => {
    expect(toUIInvoice(inv({ due_date: "2026-06-03" })).dueDate).toBe("6/3/26");
  });
  it("does not zero pad month or day", () => {
    expect(toUIInvoice(inv({ due_date: "2026-01-05" })).dueDate).toBe("1/5/26");
    expect(toUIInvoice(inv({ due_date: "2026-12-25" })).dueDate).toBe("12/25/26");
  });
  it("uses a two-digit year", () => {
    expect(toUIInvoice(inv({ due_date: "2000-01-01" })).dueDate).toBe("1/1/00");
  });
  it("renders an em dash for null or unparseable dates", () => {
    expect(toUIInvoice(inv({ due_date: null })).dueDate).toBe("—");
    expect(toUIInvoice(inv({ due_date: "garbage" })).dueDate).toBe("—");
  });
  it("formats last_reminder_at into lastActivity", () => {
    expect(toUIInvoice(inv({ last_reminder_at: null })).lastActivity).toBe("—");
    expect(toUIInvoice(inv({ last_reminder_at: "2026-09-20T15:00:00Z" })).lastActivity).toBe("9/20/26");
  });
  it("toUIClient lastActivity uses updated_at", () => {
    const withUpdated = (u: string | null) => ({ ...client, updated_at: u }) as unknown as ClientRow;
    expect(toUIClient(withUpdated("2026-09-01T00:00:00Z"), { latest: null, prior: null }, []).lastActivity).toBe("9/1/26");
    expect(toUIClient(withUpdated(null), { latest: null, prior: null }, []).lastActivity).toBe("—");
  });
  it.todo("renders the UTC calendar date regardless of host TZ (currently local getters: 2026-06-03 → 6/2/26 under America/*)");
});

describe("date formatting: daysFromToday", () => {
  const NOW = new Date("2026-09-25T21:00:00Z");
  afterEach(() => {
    vi.useRealTimers();
  });
  it("returns null for null, empty and unparseable input", () => {
    expect(daysFromToday(null, NOW)).toBeNull();
    expect(daysFromToday("", NOW)).toBeNull();
    expect(daysFromToday("garbage", NOW)).toBeNull();
  });
  it("yesterday -1, tomorrow 1, today 0 (not -0)", () => {
    expect(daysFromToday("2026-09-24", NOW)).toBe(-1);
    expect(daysFromToday("2026-09-26", NOW)).toBe(1);
    const today = daysFromToday("2026-09-25", NOW);
    expect(today).toBe(0);
    expect(Object.is(today, -0)).toBe(false);
  });
  it("crosses the year boundary", () => {
    expect(daysFromToday("2027-01-01", new Date("2026-12-31T23:59:59Z"))).toBe(1);
  });
  it("defaults now to the current (fake) time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(daysFromToday("2026-09-26")).toBe(1);
  });
  describe.each(["Pacific/Kiritimati", "America/Los_Angeles"])("TZ %s", (tz) => {
    useTZ(tz);
    it("host offset switch took effect", () => {
      expect(new Date("2026-06-03T00:00:00Z").getTimezoneOffset()).not.toBe(0);
    });
    it("today is 0 regardless of host zone", () => {
      expect(daysFromToday("2026-09-25", NOW)).toBe(0);
    });
  });
});

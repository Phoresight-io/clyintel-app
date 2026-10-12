import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  buildCallVariables,
  callVariablesFrom,
  daysPastDue,
  formatAmountDue,
  formatHumanDate,
  CALL_VARIABLE_KEYS,
  type CallVariableSources,
} from "./buildCallVariables";
import type { ContactRow } from "../outreach/selectRecipients";

const NOW = new Date("2026-09-25T21:00:00Z"); // afternoon UTC: proves no +1 day

const contact = (p: Partial<ContactRow>): ContactRow =>
  ({
    id: "c",
    client_id: "cl",
    name: null,
    email: null,
    phone: null,
    contact_type: "dunning",
    is_primary: false,
    email_rank: null,
    sms_rank: null,
    voice_rank: null,
    opt_out_email: false,
    opt_out_sms: false,
    opt_out_voice: false,
    ...p,
  }) as ContactRow;

const full = (): CallVariableSources => ({
  invoice: { invoice_number: "1036", amount_outstanding_cents: 27000, due_date: "2026-06-28" },
  client: { name: "0969 Ocean View Road" },
  subscriber: { business_name: "Phoresight", contact_name: "Charles" },
  contacts: [
    contact({ id: "v", name: "Vera Voice", phone: "+15551230000", voice_rank: 1 }),
    contact({ id: "e", name: "Ella Email", email: "ella@example.com", email_rank: 1 }),
  ],
});

describe("formatters", () => {
  it("27000 → $270.00; null → ''", () => {
    expect(formatAmountDue(27000)).toBe("$270.00");
    expect(formatAmountDue(5)).toBe("$0.05");
    expect(formatAmountDue(null)).toBe("");
  });
  it("human date: 2026-06-28 → June 28, 2026; bad → ''", () => {
    expect(formatHumanDate("2026-06-28")).toBe("June 28, 2026");
    expect(formatHumanDate("2026-01-05T00:00:00Z")).toBe("January 5, 2026");
    expect(formatHumanDate("nope")).toBe("");
    expect(formatHumanDate(null)).toBe("");
  });
  it("days past due: 2026-06-28 vs fixed today 2026-09-25 → 89; future → 0; none → ''", () => {
    expect(daysPastDue("2026-06-28", NOW)).toBe("89");
    expect(daysPastDue("2026-10-15", NOW)).toBe("0");
    expect(daysPastDue(null, NOW)).toBe("");
  });
});

describe("callVariablesFrom", () => {
  it("full ids → all keys populated with correct formats", () => {
    const v = callVariablesFrom(full(), NOW);
    expect(Object.keys(v).sort()).toEqual([...CALL_VARIABLE_KEYS].sort());
    expect(v).toEqual({
      contact_name: "Vera Voice",
      client_name: "0969 Ocean View Road",
      invoice_number: "1036",
      amount_due: "$270.00",
      due_date: "June 28, 2026",
      days_past_due: "89",
      subscriber_name: "Phoresight",
      payment_channel: "email",
    });
  });

  it("no invoice → invoice keys '', contact/subscriber keys still populated", () => {
    const v = callVariablesFrom({ ...full(), invoice: null }, NOW);
    expect(v).toMatchObject({ invoice_number: "", amount_due: "", due_date: "", days_past_due: "" });
    expect(v.contact_name).toBe("Vera Voice");
    expect(v.subscriber_name).toBe("Phoresight");
  });

  it("no voice contact but an email contact → contact_name from the email contact", () => {
    const v = callVariablesFrom(
      { ...full(), contacts: [contact({ name: "Ella Email", email: "ella@example.com", email_rank: 1 })] },
      NOW,
    );
    expect(v.contact_name).toBe("Ella Email");
  });

  it("voice-opted-out contact is skipped for voice, email fallback used", () => {
    const v = callVariablesFrom(
      {
        ...full(),
        contacts: [
          contact({ name: "Opted Out", phone: "+1555", voice_rank: 1, opt_out_voice: true }),
          contact({ name: "Ella Email", email: "ella@example.com", email_rank: 1 }),
        ],
      },
      NOW,
    );
    expect(v.contact_name).toBe("Ella Email");
  });

  it("no contacts → client name, then 'there'", () => {
    expect(callVariablesFrom({ ...full(), contacts: [] }, NOW).contact_name).toBe("0969 Ocean View Road");
    expect(callVariablesFrom({ ...full(), contacts: [], client: null }, NOW).contact_name).toBe("there");
    expect(callVariablesFrom({ ...full(), contacts: [], client: { name: "  " } }, NOW).contact_name).toBe("there");
  });

  it("subscriber_name: business_name → contact_name → 'our team'", () => {
    expect(callVariablesFrom({ ...full(), subscriber: { business_name: null, contact_name: "Charles" } }, NOW).subscriber_name).toBe("Charles");
    expect(callVariablesFrom({ ...full(), subscriber: null }, NOW).subscriber_name).toBe("our team");
  });
});

describe("buildCallVariables (reads)", () => {
  function fakeDb(rows: { invoices?: unknown; clients?: unknown; subscribers?: unknown; client_contacts?: unknown[] }) {
    const eqs: Record<string, unknown[][]> = {};
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (...args: unknown[]) => {
        (eqs[table] ??= []).push(args);
        return b;
      };
      b.maybeSingle = async () => ({ data: (rows as Record<string, unknown>)[table] ?? null, error: null });
      b.then = (resolve: (v: unknown) => void) => resolve({ data: rows.client_contacts ?? [], error: null });
      return b;
    };
    return { db: { from } as never, eqs };
  }

  it("scopes invoice/client/subscriber reads by subscriber_id and builds the set", async () => {
    const { db, eqs } = fakeDb({
      invoices: { invoice_number: "1036", amount_outstanding_cents: 27000, due_date: "2026-06-28" },
      clients: { name: "0969 Ocean View Road" },
      subscribers: { business_name: "Phoresight", contact_name: null },
      client_contacts: [contact({ name: "Vera Voice", phone: "+1555", voice_rank: 1 })],
    });
    const v = await buildCallVariables(db, { subscriberId: "sub", clientId: "cl", invoiceId: "inv" }, NOW);
    expect(v.amount_due).toBe("$270.00");
    expect(v.contact_name).toBe("Vera Voice");
    expect(eqs.invoices).toEqual([["id", "inv"], ["subscriber_id", "sub"], ["client_id", "cl"]]);
    expect(eqs.clients).toEqual([["id", "cl"], ["subscriber_id", "sub"]]);
  });

  it("no invoiceId → no invoice read, invoice keys ''", async () => {
    const { db, eqs } = fakeDb({ clients: { name: "Acme" }, subscribers: { business_name: "P", contact_name: null } });
    const v = await buildCallVariables(db, { subscriberId: "sub", clientId: "cl", invoiceId: null }, NOW);
    expect(eqs.invoices).toBeUndefined();
    expect(v.invoice_number).toBe("");
    expect(v.contact_name).toBe("Acme");
  });

  it("client not owned by subscriber → contacts not read; falls back to 'there'", async () => {
    const { db, eqs } = fakeDb({ clients: null, client_contacts: [contact({ name: "Leak", phone: "+1", voice_rank: 1 })] });
    const v = await buildCallVariables(db, { subscriberId: "sub", clientId: "cl", invoiceId: null }, NOW);
    expect(eqs.client_contacts).toBeUndefined();
    expect(v.contact_name).toBe("there");
  });

  it("read errors are logged and treated as missing (no throw)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const from = () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: null, error: { message: "boom" } });
      return b;
    };
    const v = await buildCallVariables({ from } as never, { subscriberId: "s", clientId: "c", invoiceId: "i" }, NOW);
    expect(v.contact_name).toBe("there");
    expect(v.amount_due).toBe("");
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

describe("date formatting: formatHumanDate", () => {
  it("formats full month names without a leading zero on the day", () => {
    expect(formatHumanDate("2026-12-01")).toBe("December 1, 2026");
    expect(formatHumanDate("2026-01-09")).toBe("January 9, 2026");
  });
  it.each([
    ["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"],
    ["05", "May"], ["06", "June"], ["07", "July"], ["08", "August"],
    ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"],
  ])("month %s → %s", (m, name) => {
    expect(formatHumanDate(`2026-${m}-15`)).toBe(`${name} 15, 2026`);
  });
  it("takes the literal date prefix of an offset timestamp (no TZ conversion)", () => {
    expect(formatHumanDate("2026-06-28T23:30:00-05:00")).toBe("June 28, 2026");
  });
  it("rejects bad months and malformed strings", () => {
    expect(formatHumanDate("2026-00-10")).toBe("");
    expect(formatHumanDate("2026-13-10")).toBe("");
    expect(formatHumanDate("2026-6-28")).toBe("");
    expect(formatHumanDate(" 2026-06-28")).toBe("");
  });
  it("returns empty string for empty and undefined", () => {
    expect(formatHumanDate("")).toBe("");
    expect(formatHumanDate(undefined as unknown as string)).toBe("");
  });
  describe.each(["America/Los_Angeles", "Pacific/Kiritimati"])("TZ %s", (tz) => {
    useTZ(tz);
    it("host offset switch took effect", () => {
      expect(new Date("2026-06-03T00:00:00Z").getTimezoneOffset()).not.toBe(0);
    });
    it("is timezone independent", () => {
      expect(formatHumanDate("2026-06-28")).toBe("June 28, 2026");
    });
  });
  it.todo("rejects an impossible day such as 2026-02-30 (currently 'February 30, 2026')");
});

describe("date formatting: daysPastDue", () => {
  it("due today 0, yesterday 1, tomorrow clamped to 0", () => {
    expect(daysPastDue("2026-09-25", NOW)).toBe("0");
    expect(daysPastDue("2026-09-24", NOW)).toBe("1");
    expect(daysPastDue("2026-09-26", NOW)).toBe("0");
  });
  it("crosses the year boundary", () => {
    expect(daysPastDue("2026-12-31", new Date("2027-01-01T00:00:00Z"))).toBe("1");
  });
  it("returns empty string for empty, garbage or invalid now", () => {
    expect(daysPastDue("", NOW)).toBe("");
    expect(daysPastDue("garbage", NOW)).toBe("");
    expect(daysPastDue("2026-09-24", new Date(NaN))).toBe("");
  });
  it("always returns a string", () => {
    expect(typeof daysPastDue("2026-09-24", NOW)).toBe("string");
    expect(typeof daysPastDue("2026-09-26", NOW)).toBe("string");
    expect(typeof daysPastDue("", NOW)).toBe("string");
  });
});

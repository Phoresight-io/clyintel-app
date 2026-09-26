import { describe, it, expect, vi, beforeEach } from "vitest";

// The REAL default port (createDefaultPort) end-to-end over a table-aware fake
// Supabase client — no injected port. Proves the cadence path (no recipient, no
// clientOptOutEmail in ctx) actually READS clients.opt_out_email and passes the
// real value into pickRecipient (Half B), not just that pickRecipient folds it in.

const db = {
  clientOptOut: false as boolean | null,
  clientFound: true,
  clientReadError: false,
  selects: [] as { table: string; cols: string }[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
};

const CONTACTS = [
  {
    id: "c-dun", client_id: "client-1", email: "ap@acme.com", phone: null, is_primary: false, role: null, name: "Ada",
    opt_out_email: false, opt_out_sms: false, opt_out_voice: false, contact_type: "dunning",
    email_rank: 1, sms_rank: null, voice_rank: null, created_at: "", updated_at: "",
  },
];

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      let cols = "";
      const b: Record<string, unknown> = {};
      b.select = (c: string) => {
        cols = c;
        db.selects.push({ table, cols: c });
        return b;
      };
      for (const m of ["eq", "limit", "update"]) b[m] = () => b;
      b.insert = (row: Record<string, unknown>) => {
        db.inserts.push({ table, row });
        return b;
      };
      b.single = async () => ({ data: { id: `${table}-id` }, error: null });
      b.maybeSingle = async () => {
        if (table === "clients") {
          if (cols === "opt_out_email") {
            if (db.clientReadError) return { data: null, error: { message: "boom" } };
            return { data: db.clientFound ? { opt_out_email: db.clientOptOut } : null, error: null };
          }
          return { data: { name: "Acme", payment_link_url: null }, error: null };
        }
        if (table === "templates") return { data: { id: "tpl-1", subject: "Invoice {{invoice_number}}", body: "Pay {{payment_link}}" }, error: null };
        if (table === "invoices") return { data: { invoice_number: "1036", amount_outstanding_cents: 27000, due_date: "2026-06-28", issue_date: "2026-05-28" }, error: null };
        if (table === "subscribers") return { data: { payment_link_url: "https://pay.example/sub", business_name: "Phoresight", contact_name: null }, error: null };
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => void) =>
        resolve({ data: table === "client_contacts" ? CONTACTS : [], error: null });
      return b;
    },
  }),
}));

const sendEmail = vi.fn(async () => ({ messageId: "ms-1" }));
vi.mock("@/lib/email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...(a as [])) }));

import { sendEmailStep } from "./sendEmailStep";

// Exactly the cadence's ctx shape (lib/outreach/runCadence.ts): no recipient, no flag.
const CADENCE_CTX = { subscriberId: "sub-1", clientId: "client-1", invoiceId: "inv-1" };

beforeEach(() => {
  db.clientOptOut = false;
  db.clientFound = true;
  db.clientReadError = false;
  db.selects.length = 0;
  db.inserts.length = 0;
  sendEmail.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sendEmailStep default port — cadence path reads clients.opt_out_email", () => {
  it("reads clients.opt_out_email on the cadence path (Half B)", async () => {
    await sendEmailStep(CADENCE_CTX, "dry_run");
    expect(db.selects).toContainEqual({ table: "clients", cols: "opt_out_email" });
  });

  it("client opted out (DB true), contact not → channel_denied, nothing written, nothing sent", async () => {
    db.clientOptOut = true;
    const res = await sendEmailStep(CADENCE_CTX, "live");
    expect(res.outcome).toBe("channel_denied");
    expect(db.inserts).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("REGRESSION: client NOT opted out (DB false) → still sends exactly as today (cadence did not fail closed)", async () => {
    db.clientOptOut = false;
    const res = await sendEmailStep(CADENCE_CTX, "live");
    expect(res.outcome).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ap@acme.com" }));
    const comm = db.inserts.find((i) => i.table === "communications");
    expect(comm?.row).toMatchObject({ to_address: "ap@acme.com", client_id: "client-1", invoice_id: "inv-1" });
    expect(db.inserts.filter((i) => i.table === "recovery_attempts")).toHaveLength(1);
  });

  it("client row unreadable or missing → fail closed (no_primary_contact), nothing written", async () => {
    db.clientReadError = true;
    expect((await sendEmailStep(CADENCE_CTX, "live")).outcome).toBe("no_primary_contact");
    db.clientReadError = false;
    db.clientFound = false;
    expect((await sendEmailStep(CADENCE_CTX, "live")).outcome).toBe("no_primary_contact");
    expect(db.inserts).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("DB flag null → fail closed (channel_denied)", async () => {
    db.clientOptOut = null;
    expect((await sendEmailStep(CADENCE_CTX, "live")).outcome).toBe("channel_denied");
  });

  it("an explicit flag from an override caller still wins over the DB value", async () => {
    db.clientOptOut = true;
    const res = await sendEmailStep(
      { ...CADENCE_CTX, recipient: { contactId: "c-dun" }, clientOptOutEmail: false },
      "live",
    );
    expect(res.outcome).toBe("sent");
  });
});

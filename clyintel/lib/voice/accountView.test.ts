import { describe, it, expect } from "vitest";
import { buildAccountView, isEmailable } from "./accountView";
import type { ContactRow } from "../outreach/selectRecipients";

const contact = (over: Partial<ContactRow>): ContactRow => ({
  id: "c1",
  client_id: "cl",
  email: "ap@acme.com",
  phone: "+15551230000",
  is_primary: false,
  role: "AP",
  name: "Ada",
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
  contact_type: "dunning",
  email_rank: 1,
  sms_rank: null,
  voice_rank: 1,
  created_at: "",
  updated_at: "",
  ...over,
});

const DUN = contact({ id: "c-dun" });
const POC = contact({ id: "c-poc", contact_type: "poc", email: "Owner@Acme.com", name: "Owner", role: null });
const OUT = contact({ id: "c-out", email: "old@acme.com", opt_out_email: true });
const VOICE_OUT = contact({ id: "c-vout", email: "calls-no@acme.com", opt_out_voice: true, email_rank: 2 });
const NO_EMAIL = contact({ id: "c-none", email: null });

const src = (over = {}) => ({
  client: { name: " Acme Co ", opt_out_email: false },
  invoice: { invoice_number: "1036", amount_outstanding_cents: 27000, due_date: "2026-06-28" },
  contacts: [DUN, POC, OUT, VOICE_OUT, NO_EMAIL],
  paymentEmailStatus: null,
  ...over,
});

describe("get_account view", () => {
  it("shape: client, invoice (formatted), contacts with FULL emails, default, status", () => {
    const v = buildAccountView(src());
    expect(v.client_name).toBe("Acme Co");
    expect(v.invoice).toEqual({ number: "1036", amount_due: "$270.00", due_date: "June 28, 2026" });
    expect(v.contacts.map((c) => c.email)).toEqual([
      "ap@acme.com",
      "Owner@Acme.com",
      "old@acme.com",
      "calls-no@acme.com",
      null,
    ]);
    expect(v.contacts[1]).toEqual({
      contact_id: "c-poc",
      name: "Owner",
      role: null,
      contact_type: "poc",
      email: "Owner@Acme.com",
      emailable: true,
    });
    expect(v.default_contact_id).toBe("c-dun");
    expect(v.payment_email_status).toBeNull();
  });

  it("NEVER includes a payment link", () => {
    const json = JSON.stringify(buildAccountView(src()));
    expect(json).not.toMatch(/payment_link|https?:\/\//i);
  });

  it("emailable: needs email, contact not opted out, client not opted out; voice opt-out ignored", () => {
    const v = buildAccountView(src());
    const e = Object.fromEntries(v.contacts.map((c) => [c.contact_id, c.emailable]));
    expect(e).toEqual({ "c-dun": true, "c-poc": true, "c-out": false, "c-vout": true, "c-none": false });
  });

  it("client opted out of email → nobody emailable, no default", () => {
    const v = buildAccountView(src({ client: { name: "Acme", opt_out_email: true } }));
    expect(v.contacts.every((c) => !c.emailable)).toBe(true);
    expect(v.default_contact_id).toBeNull();
    expect(isEmailable(DUN, null)).toBe(false); // unknown client flag → fail closed
  });

  it("no invoice → invoice null; status passes through", () => {
    const v = buildAccountView(src({ invoice: null, paymentEmailStatus: "sent" }));
    expect(v.invoice).toBeNull();
    expect(v.payment_email_status).toBe("sent");
  });
});

import { describe, it, expect } from "vitest";
import { selectFromContacts, type ContactRow } from "./selectRecipients";

const contact = (over: Partial<ContactRow>): ContactRow => ({
  id: "00000000-0000-0000-0000-000000000000",
  client_id: "client-1",
  email: null,
  phone: null,
  is_primary: false,
  role: null,
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("selectFromContacts — v1 primary-only", () => {
  it("returns only the primary contact", () => {
    const primary = contact({ id: "p", is_primary: true, email: "p@x.com" });
    const secondary = contact({ id: "s", is_primary: false, email: "s@x.com" });
    expect(selectFromContacts([secondary, primary])).toEqual([primary]);
  });

  it("returns primary-only even under future strategies (v1 ignores strategy)", () => {
    const primary = contact({ id: "p", is_primary: true });
    const other = contact({ id: "o", is_primary: false });
    expect(selectFromContacts([primary, other], "all")).toEqual([primary]);
    expect(selectFromContacts([primary, other], "ai_escalation")).toEqual([primary]);
  });

  it("returns empty when the client has no primary contact (unsendable)", () => {
    // e.g. the 1 email-less client that got no primary in the 0a backfill.
    expect(selectFromContacts([])).toEqual([]);
    expect(selectFromContacts([contact({ is_primary: false })])).toEqual([]);
  });
});

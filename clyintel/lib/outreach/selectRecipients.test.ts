import { describe, it, expect } from "vitest";
import {
  selectFromContacts,
  selectForChannel,
  EMAIL_CHANNEL,
  type ContactRow,
} from "./selectRecipients";

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
  contact_type: null,
  email_rank: null,
  sms_rank: null,
  voice_rank: null,
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

describe("selectForChannel — email: eligibility-walk (lowest-ranked eligible dunning), then poc", () => {
  const poc = (over: Partial<ContactRow> = {}) =>
    contact({ id: "poc", contact_type: "poc", email: "poc@x.com", email_rank: 1, ...over });
  const dunning1 = (over: Partial<ContactRow> = {}) =>
    contact({ id: "d1", contact_type: "dunning", email: "d1@x.com", email_rank: 1, ...over });
  const dunning2 = (over: Partial<ContactRow> = {}) =>
    contact({ id: "d2", contact_type: "dunning", email: "d2@x.com", email_rank: 2, ...over });

  it("eligible rank-1 dunning wins over an existing poc", () => {
    expect(selectForChannel([poc(), dunning1()], EMAIL_CHANNEL)?.id).toBe("d1");
  });

  it("rank-2 dunning (no rank-1 dunning), eligible → chosen over an eligible poc (THE Brick-4b bug: PoC holds email_rank=1, user's dunning is Secondary)", () => {
    // Regression: previously the rank-2 dunning fell through to the poc.
    expect(selectForChannel([poc(), dunning2()], EMAIL_CHANNEL)?.id).toBe("d2");
  });

  it("lowest rank wins: rank-1 dunning beats rank-2 dunning (both eligible)", () => {
    expect(selectForChannel([dunning2(), dunning1()], EMAIL_CHANNEL)?.id).toBe("d1");
  });

  it("rank-1 dunning opted-out of email + rank-2 dunning eligible → walks to rank-2 (eligibility-walk)", () => {
    const chosen = selectForChannel(
      [poc(), dunning1({ opt_out_email: true }), dunning2()],
      EMAIL_CHANNEL,
    );
    expect(chosen?.id).toBe("d2");
  });

  it("rank-1 dunning with no email address + rank-2 dunning eligible → walks to rank-2", () => {
    const chosen = selectForChannel(
      [poc(), dunning1({ email: null }), dunning2()],
      EMAIL_CHANNEL,
    );
    expect(chosen?.id).toBe("d2");
  });

  it("all dunning ineligible (opted-out) → falls to eligible poc", () => {
    const chosen = selectForChannel(
      [poc(), dunning1({ opt_out_email: true }), dunning2({ opt_out_email: true })],
      EMAIL_CHANNEL,
    );
    expect(chosen?.id).toBe("poc");
  });

  it("dunning eligible but with NULL email_rank → does not participate in email; falls to poc", () => {
    const chosen = selectForChannel(
      [poc(), contact({ id: "dnull", contact_type: "dunning", email: "dn@x.com", email_rank: null })],
      EMAIL_CHANNEL,
    );
    expect(chosen?.id).toBe("poc");
  });

  it("only a NULL-email_rank dunning (no poc) → none (unranked for this channel)", () => {
    const chosen = selectForChannel(
      [contact({ id: "dnull", contact_type: "dunning", email: "dn@x.com", email_rank: null })],
      EMAIL_CHANNEL,
    );
    expect(chosen).toBeNull();
  });

  it("no dunning, eligible poc → poc selected (the backfill case: contact_type='poc', email_rank=1)", () => {
    expect(selectForChannel([poc()], EMAIL_CHANNEL)?.id).toBe("poc");
  });

  it("poc opted-out of email → none (unsendable)", () => {
    expect(selectForChannel([poc({ opt_out_email: true })], EMAIL_CHANNEL)).toBeNull();
  });

  it("poc with no email address (or whitespace) → none", () => {
    expect(selectForChannel([poc({ email: null })], EMAIL_CHANNEL)).toBeNull();
    expect(selectForChannel([poc({ email: "   " })], EMAIL_CHANNEL)).toBeNull();
  });

  it("no contacts → none", () => {
    expect(selectForChannel([], EMAIL_CHANNEL)).toBeNull();
  });
});

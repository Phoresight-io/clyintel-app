import { describe, it, expect } from "vitest";
import {
  evaluateOutreachEligibility,
  isContactAllowed,
  SIMULATION_NOTE,
  type EligInvoice,
  type EligClient,
} from "./eligibility";

// Fixed reference "today" so past-due is deterministic.
const NOW = new Date("2026-07-04T00:00:00.000Z");

const CLIENT_BOTH: EligClient = { id: "c1", email: "a@x.com", phone: "555-1" };
const CLIENT_EMAIL_ONLY: EligClient = { id: "c2", email: "b@x.com", phone: null };
const CLIENT_PHONE_ONLY: EligClient = { id: "c3", email: null, phone: "555-3" };
const CLIENT_NEITHER: EligClient = { id: "c4", email: null, phone: null };

function inv(overrides: Partial<EligInvoice> & { id: string; client_id: string }): EligInvoice {
  return { subscriber_id: "sub_1", due_date: "2026-05-01", ...overrides };
}

describe("evaluateOutreachEligibility — predicate matrix", () => {
  it("past-due + email → one SIMULATION row, invoice_id is the LOCAL uuid", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv_local_1", client_id: "c1", due_date: "2026-05-01" })],
      [CLIENT_BOTH],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      subscriber_id: "sub_1",
      client_id: "c1",
      invoice_id: "inv_local_1", // LOCAL invoices.id, never external_id
      channel: "email",
      status: "sent",
      sent_at: "2026-07-04T00:00:00.000Z",
      attempt_number: 1,
      counted_toward_limit: false,
      notes: SIMULATION_NOTE,
      communication_id: null,
    });
  });

  it("not past-due (due_date in the future) → no row", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv2", client_id: "c1", due_date: "2026-08-01" })],
      [CLIENT_BOTH],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("due_date === today (not strictly before) → no row", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv2b", client_id: "c1", due_date: "2026-07-04T00:00:00.000Z" })],
      [CLIENT_BOTH],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("null due_date → NOT eligible (fail closed)", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv3", client_id: "c1", due_date: null })],
      [CLIENT_BOTH],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("unparseable due_date → no row (fail closed)", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv3b", client_id: "c1", due_date: "not-a-date" })],
      [CLIENT_BOTH],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("already attempted (invoice_id in skip-set) → no row", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv4", client_id: "c1", due_date: "2026-05-01" })],
      [CLIENT_BOTH],
      new Set(["inv4"]),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("no email and no phone → not contactable → no row", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv5", client_id: "c4", due_date: "2026-05-01" })],
      [CLIENT_NEITHER],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("email-only → channel 'email'", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv6", client_id: "c2", due_date: "2026-05-01" })],
      [CLIENT_EMAIL_ONLY],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("email");
  });

  it("phone-only → channel 'sms' (still a SIMULATION stub)", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv7", client_id: "c3", due_date: "2026-05-01" })],
      [CLIENT_PHONE_ONLY],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("sms");
    expect(rows[0].notes).toBe(SIMULATION_NOTE);
  });

  it("invoice referencing an unknown client → no row", () => {
    const rows = evaluateOutreachEligibility(
      [inv({ id: "inv8", client_id: "missing", due_date: "2026-05-01" })],
      [CLIENT_BOTH],
      new Set(),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("mixed batch → only the eligible invoices produce rows", () => {
    const rows = evaluateOutreachEligibility(
      [
        inv({ id: "e1", client_id: "c1", due_date: "2026-05-01" }), // eligible
        inv({ id: "e2", client_id: "c2", due_date: "2026-08-01" }), // future
        inv({ id: "e3", client_id: "c4", due_date: "2026-05-01" }), // no contact
        inv({ id: "e4", client_id: "c3", due_date: "2026-05-01" }), // eligible (sms)
        inv({ id: "e5", client_id: "c1", due_date: "2026-05-01" }), // already attempted
      ],
      [CLIENT_BOTH, CLIENT_EMAIL_ONLY, CLIENT_PHONE_ONLY, CLIENT_NEITHER],
      new Set(["e5"]),
      NOW,
    );
    expect(rows.map((r) => r.invoice_id).sort()).toEqual(["e1", "e4"]);
  });
});

describe("isContactAllowed (permissibility seam stub)", () => {
  it("returns true today (real rules deferred)", () => {
    expect(isContactAllowed(CLIENT_BOTH, NOW)).toBe(true);
  });
});

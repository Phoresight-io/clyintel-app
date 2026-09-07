import { describe, it, expect } from "vitest";
import { planPocReconcile } from "./planPocReconcile";

// Helpers to build the three input maps concisely.
const merged = (email: string | null, phone: string | null = null) => ({ email, phone });

describe("planPocReconcile — QBO PoC reconcile decision (pure)", () => {
  it("existing PoC → UPDATE (email/phone), no insert", () => {
    const existingPoc = new Map([["client-1", "poc-1"]]);
    const clientIdByQboId = new Map([["qbo-1", "client-1"]]);
    const mergedByQboId = new Map([["qbo-1", merged("new@x.com", "555-1")]]);

    const plan = planPocReconcile(existingPoc, clientIdByQboId, mergedByQboId);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([{ id: "poc-1", email: "new@x.com", phone: "555-1" }]);
  });

  it("no PoC + email present → INSERT (contact_type='poc', email_rank=1, is_primary=true)", () => {
    const existingPoc = new Map<string, string>(); // no PoC for this client
    const clientIdByQboId = new Map([["qbo-1", "client-1"]]);
    const mergedByQboId = new Map([["qbo-1", merged("a@x.com", "555-9")]]);

    const plan = planPocReconcile(existingPoc, clientIdByQboId, mergedByQboId);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([
      {
        client_id: "client-1",
        email: "a@x.com",
        phone: "555-9",
        is_primary: true,
        contact_type: "poc",
        email_rank: 1,
        sms_rank: 1, // phone present
        voice_rank: 1,
      },
    ]);
  });

  it("no PoC + no email → neither insert nor update (skip)", () => {
    const existingPoc = new Map<string, string>();
    const clientIdByQboId = new Map([["qbo-1", "client-1"]]);
    const mergedByQboId = new Map([["qbo-1", merged(null, "555-1")]]); // no email

    const plan = planPocReconcile(existingPoc, clientIdByQboId, mergedByQboId);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it("NON-CLOBBER: a client whose only contact is dunning (absent from the poc map) → fresh PoC INSERT, ZERO updates", () => {
    // The poc-filtered read excluded the dunning contact, so existingPocIdByClientId
    // has NO entry for client-1. The decision must therefore INSERT a new PoC and
    // emit no update — no update can ever reference the dunning contact's id.
    const existingPoc = new Map<string, string>(); // dunning-only client → not present
    const clientIdByQboId = new Map([["qbo-1", "client-1"]]);
    const mergedByQboId = new Map([["qbo-1", merged("poc@x.com", "555-2")]]);

    const plan = planPocReconcile(existingPoc, clientIdByQboId, mergedByQboId);
    expect(plan.updates).toEqual([]); // <- executable proof: re-sync touches no dunning row
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({ client_id: "client-1", contact_type: "poc" });
  });

  it("phone present → sms_rank/voice_rank = 1; phone absent (or whitespace) → null", () => {
    const clientIdByQboId = new Map([
      ["qbo-withphone", "client-a"],
      ["qbo-nophone", "client-b"],
      ["qbo-blankphone", "client-c"],
    ]);
    const mergedByQboId = new Map([
      ["qbo-withphone", merged("a@x.com", "555-1")],
      ["qbo-nophone", merged("b@x.com", null)],
      ["qbo-blankphone", merged("c@x.com", "   ")],
    ]);
    const plan = planPocReconcile(new Map(), clientIdByQboId, mergedByQboId);

    const byClient = Object.fromEntries(plan.inserts.map((i) => [i.client_id, i]));
    expect(byClient["client-a"]).toMatchObject({ sms_rank: 1, voice_rank: 1 });
    expect(byClient["client-b"]).toMatchObject({ sms_rank: null, voice_rank: null });
    expect(byClient["client-c"]).toMatchObject({ sms_rank: null, voice_rank: null });
    // email_rank is always 1 on an insert (email is present in all three).
    expect(byClient["client-b"]).toMatchObject({ email_rank: 1 });
  });
});

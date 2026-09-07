import { describe, it, expect } from "vitest";
import {
  rankLabel,
  sortContactsForDisplay,
  type ClientContactDisplay,
} from "./contactDisplay";

const contact = (over: Partial<ClientContactDisplay>): ClientContactDisplay => ({
  id: "c",
  contact_type: "poc",
  email: "x@y.com",
  phone: null,
  email_rank: 1,
  sms_rank: null,
  voice_rank: null,
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
  ...over,
});

describe("rankLabel", () => {
  it("1 → Primary, 2 → Secondary, null → —, else #N", () => {
    expect(rankLabel(1)).toBe("Primary");
    expect(rankLabel(2)).toBe("Secondary");
    expect(rankLabel(null)).toBe("—");
    expect(rankLabel(3)).toBe("#3");
  });
});

describe("sortContactsForDisplay", () => {
  it("dunning before poc", () => {
    const poc = contact({ id: "poc", contact_type: "poc", email_rank: 1 });
    const dun = contact({ id: "dun", contact_type: "dunning", email_rank: 1 });
    expect(sortContactsForDisplay([poc, dun]).map((c) => c.id)).toEqual(["dun", "poc"]);
  });

  it("within dunning: by email_rank ascending, nulls last, then sms_rank", () => {
    const d1 = contact({ id: "d1", contact_type: "dunning", email_rank: 1 });
    const d2 = contact({ id: "d2", contact_type: "dunning", email_rank: 2 });
    const dNull = contact({ id: "dnull", contact_type: "dunning", email_rank: null, sms_rank: 1 });
    const dNull2 = contact({ id: "dnull2", contact_type: "dunning", email_rank: null, sms_rank: 2 });
    // input intentionally out of order
    const out = sortContactsForDisplay([dNull2, d2, dNull, d1]).map((c) => c.id);
    expect(out).toEqual(["d1", "d2", "dnull", "dnull2"]); // ranks 1,2, then null-email tie broken by sms_rank
  });

  it("legacy/untyped (contact_type null) sorts last", () => {
    const poc = contact({ id: "poc", contact_type: "poc" });
    const legacy = contact({ id: "legacy", contact_type: null });
    const dun = contact({ id: "dun", contact_type: "dunning" });
    expect(sortContactsForDisplay([legacy, poc, dun]).map((c) => c.id)).toEqual(["dun", "poc", "legacy"]);
  });

  it("is pure — does not mutate the input array", () => {
    const input = [contact({ id: "a", contact_type: "poc" }), contact({ id: "b", contact_type: "dunning" })];
    const snapshot = input.map((c) => c.id);
    sortContactsForDisplay(input);
    expect(input.map((c) => c.id)).toEqual(snapshot);
  });
});

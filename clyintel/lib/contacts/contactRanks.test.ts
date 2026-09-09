import { describe, it, expect } from "vitest";
import { takenEmailRanks } from "./contactRanks";
import type { ClientContactDisplay } from "./contactDisplay";

const contact = (over: Partial<ClientContactDisplay>): ClientContactDisplay => ({
  id: "c",
  name: null,
  contact_type: "dunning",
  email: "x@y.com",
  phone: null,
  email_rank: null,
  sms_rank: null,
  voice_rank: null,
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
  ...over,
});

describe("takenEmailRanks", () => {
  it("collects non-null email_ranks across ALL contact types (poc + dunning)", () => {
    const taken = takenEmailRanks([
      contact({ id: "poc", contact_type: "poc", email_rank: 1 }),
      contact({ id: "d2", contact_type: "dunning", email_rank: 2 }),
      contact({ id: "dnull", contact_type: "dunning", email_rank: null }),
    ]);
    expect([...taken].sort()).toEqual([1, 2]); // PoC's rank 1 IS taken (matches the DB index)
  });

  it("excludeId keeps the edited contact's own rank available", () => {
    const taken = takenEmailRanks(
      [
        contact({ id: "d1", email_rank: 1 }),
        contact({ id: "d2", email_rank: 2 }),
      ],
      "d1",
    );
    expect(taken.has(1)).toBe(false); // d1 excluded → its rank 1 is free to keep
    expect(taken.has(2)).toBe(true);
  });

  it("empty / all-null → empty set", () => {
    expect(takenEmailRanks([]).size).toBe(0);
    expect(takenEmailRanks([contact({ id: "a", email_rank: null })]).size).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { mergeClientContact } from "./mergeClientContact";

describe("mergeClientContact — non-clobber coalesce", () => {
  it("incoming-only: QBO supplies contact, no existing row → uses incoming", () => {
    expect(
      mergeClientContact(
        { PrimaryEmailAddr: { Address: "new@acme.com" }, PrimaryPhone: { FreeFormNumber: "555-1000" } },
        undefined,
      ),
    ).toEqual({ email: "new@acme.com", phone: "555-1000" });
  });

  it("existing-only: QBO omits contact, existing present → keeps existing (never nulls it out)", () => {
    expect(
      mergeClientContact(
        {}, // QBO returned no PrimaryEmailAddr / PrimaryPhone
        { email: "kept@acme.com", phone: "555-2000" },
      ),
    ).toEqual({ email: "kept@acme.com", phone: "555-2000" });
  });

  it("both: incoming wins over existing", () => {
    expect(
      mergeClientContact(
        { PrimaryEmailAddr: { Address: "fresh@acme.com" }, PrimaryPhone: { FreeFormNumber: "555-3000" } },
        { email: "stale@acme.com", phone: "555-9999" },
      ),
    ).toEqual({ email: "fresh@acme.com", phone: "555-3000" });
  });

  it("neither: no incoming, no existing → null", () => {
    expect(mergeClientContact({}, undefined)).toEqual({ email: null, phone: null });
    expect(mergeClientContact({}, { email: null, phone: null })).toEqual({ email: null, phone: null });
  });

  it("per-field independence: incoming email present, phone absent → new email, existing phone kept", () => {
    expect(
      mergeClientContact(
        { PrimaryEmailAddr: { Address: "only-email@acme.com" } },
        { email: "old@acme.com", phone: "555-4000" },
      ),
    ).toEqual({ email: "only-email@acme.com", phone: "555-4000" });
  });

  it("nested object present but inner field absent → falls back to existing", () => {
    expect(
      mergeClientContact(
        { PrimaryEmailAddr: {}, PrimaryPhone: {} }, // objects present, Address/FreeFormNumber undefined
        { email: "fallback@acme.com", phone: "555-5000" },
      ),
    ).toEqual({ email: "fallback@acme.com", phone: "555-5000" });
  });
});

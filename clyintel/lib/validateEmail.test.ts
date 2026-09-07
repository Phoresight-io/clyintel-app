import { describe, it, expect } from "vitest";
import { validateEmail } from "./validateEmail";

describe("validateEmail", () => {
  it("accepts a well-formed address and returns the trimmed value", () => {
    expect(validateEmail("payer@example.com")).toEqual({ ok: true, email: "payer@example.com" });
    expect(validateEmail("  payer@example.com  ")).toEqual({ ok: true, email: "payer@example.com" });
    expect(validateEmail("a.b+tag@sub.domain.co")).toEqual({ ok: true, email: "a.b+tag@sub.domain.co" });
  });

  it("empty / whitespace → reason 'empty' (distinct from malformed)", () => {
    expect(validateEmail("")).toEqual({ ok: false, reason: "empty" });
    expect(validateEmail("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("malformed → reason 'invalid email'", () => {
    expect(validateEmail("nope")).toEqual({ ok: false, reason: "invalid email" }); // no @
    expect(validateEmail("a b@c.com")).toEqual({ ok: false, reason: "invalid email" }); // space
    expect(validateEmail("a@b")).toEqual({ ok: false, reason: "invalid email" }); // no tld
    expect(validateEmail("a@.com")).toEqual({ ok: false, reason: "invalid email" }); // empty domain label
    expect(validateEmail("@b.com")).toEqual({ ok: false, reason: "invalid email" }); // no local part
  });
});

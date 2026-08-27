import { describe, it, expect } from "vitest";
import { isChannelAllowed, type ContactOptOuts, type Channel } from "./isChannelAllowed";

const contact = (over: Partial<ContactOptOuts>): ContactOptOuts => ({
  opt_out_email: false,
  opt_out_sms: false,
  opt_out_voice: false,
  ...over,
});

describe("isChannelAllowed — deterministic fail-closed opt-out gate", () => {
  it("allows a channel when its opt-out flag is explicitly false", () => {
    expect(isChannelAllowed(contact({ opt_out_email: false }), "email")).toBe(true);
    expect(isChannelAllowed(contact({ opt_out_sms: false }), "sms")).toBe(true);
    expect(isChannelAllowed(contact({ opt_out_voice: false }), "voice")).toBe(true);
  });

  it("denies a channel when its opt-out flag is true", () => {
    expect(isChannelAllowed(contact({ opt_out_email: true }), "email")).toBe(false);
    expect(isChannelAllowed(contact({ opt_out_sms: true }), "sms")).toBe(false);
    expect(isChannelAllowed(contact({ opt_out_voice: true }), "voice")).toBe(false);
  });

  it("fails closed on a null/undefined contact", () => {
    expect(isChannelAllowed(null, "email")).toBe(false);
    expect(isChannelAllowed(undefined, "sms")).toBe(false);
  });

  it("fails closed when the opt-out flag is null (not explicitly false)", () => {
    // A null opt-out is not consent — deny.
    expect(isChannelAllowed(contact({ opt_out_email: null as unknown as boolean }), "email")).toBe(false);
  });

  it("fails closed on an unknown channel", () => {
    expect(isChannelAllowed(contact({}), "carrier_pigeon" as unknown as Channel)).toBe(false);
  });

  it("per-channel independence: an email opt-out does not block sms or voice", () => {
    const c = contact({ opt_out_email: true, opt_out_sms: false, opt_out_voice: false });
    expect(isChannelAllowed(c, "email")).toBe(false);
    expect(isChannelAllowed(c, "sms")).toBe(true);
    expect(isChannelAllowed(c, "voice")).toBe(true);
  });
});

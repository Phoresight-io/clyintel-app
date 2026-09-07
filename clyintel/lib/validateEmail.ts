// Pure validator for a contact email address (Contacts Brick 4a).
// Pragmatic shape check — local@domain.tld, no whitespace — NOT full RFC 5322.
// The goal is to reject obvious junk before a write, not to certify deliverability.
//
// Empty/whitespace input is reported distinctly (reason "empty") so callers can
// phrase a "required" message; any other malformed value → reason "invalid email".
//
// Mirrors validatePaymentLink's discriminated-union shape. Pure — no I/O, no
// dependencies (zod is not a project dependency) — so it is unit-testable and
// reusable on both client and server.

export type ValidateEmailResult =
  | { ok: true; email: string }
  | { ok: false; reason: string };

// local@domain.tld: one-or-more non-space/non-@ chars, "@", a domain label,
// a literal dot, and a TLD label. Deliberately permissive beyond that.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(raw: string): ValidateEmailResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false, reason: "invalid email" };
  }
  return { ok: true, email: trimmed };
}

// Pure validator for account-level default payment links (Brick A′-1).
// Accepts any https URL that has a non-empty host; rejects http and every other
// protocol. Permissive beyond that — path/query/fragment are not inspected.
//
// Empty/whitespace input is treated as an INVALID submit here, not as a clear:
// this brick has no clear path. Removing an existing link is guarded
// (impact-check + warning) and ships separately in A′-2.
//
// Pure — no I/O, no dependencies (zod is not a project dependency) — so it is
// unit-testable and reusable on both client and server.

export type ValidatePaymentLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export function validatePaymentLink(raw: string): ValidatePaymentLinkResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Enter a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Link must start with https://" };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: "Link must include a domain." };
  }

  return { ok: true, url: trimmed };
}

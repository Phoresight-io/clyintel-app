// Pure, dependency-free contact merge for the QBO client sync (Brick 0).
//
// Coalesce (non-clobber) rule: the incoming QBO value wins when present;
// otherwise keep the value we already have stored; null only when neither
// exists. This means a re-sync where QBO omits an email/phone NEVER nulls out a
// value we already hold (e.g. one entered manually) — supabase-js .upsert always
// writes every column in the payload, so the coalesced value must be computed
// here, before the upsert.
//
// No imports: unit-testable with zero mocking.

// Minimal structural shape of the QBO Customer fields we read. Both the object
// and its inner field are optional — a customer may carry neither.
export interface QboContactSource {
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
}

// The contact values already stored on the clients row (from a prior sync or
// manual entry). Undefined when the client is new (no existing row).
export interface ExistingContact {
  email?: string | null;
  phone?: string | null;
}

export interface MergedContact {
  email: string | null;
  phone: string | null;
}

export function mergeClientContact(
  incoming: QboContactSource,
  existing: ExistingContact | undefined,
): MergedContact {
  return {
    email: incoming.PrimaryEmailAddr?.Address ?? existing?.email ?? null,
    phone: incoming.PrimaryPhone?.FreeFormNumber ?? existing?.phone ?? null,
  };
}

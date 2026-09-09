// Pure display helpers for the read-only Contacts card (Contacts Brick 3).
// No I/O, no `@/` imports — unit-testable directly (same convention as
// mergeClientContact / planPocReconcile).

// Minimal display shape the Contacts card needs (a subset of the client_contacts
// Row). Kept as a plain interface so this module stays pure and portable.
export interface ClientContactDisplay {
  id: string;
  name: string | null; // person's name; null → greeting falls back to company
  contact_type: string | null; // 'poc' | 'dunning' | (null legacy)
  email: string | null;
  phone: string | null;
  email_rank: number | null;
  sms_rank: number | null;
  voice_rank: number | null;
  opt_out_email: boolean;
  opt_out_sms: boolean;
  opt_out_voice: boolean;
}

/** Human label for a per-channel rank: 1 → "Primary", 2 → "Secondary",
 *  null → "—", anything else → "#N". */
export function rankLabel(rank: number | null): string {
  if (rank === null) return "—";
  if (rank === 1) return "Primary";
  if (rank === 2) return "Secondary";
  return `#${rank}`;
}

// Ascending compare with nulls sorted LAST.
function nullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

// Type ordering: dunning first, then poc, then anything else (legacy null) last.
function typeWeight(contactType: string | null): number {
  if (contactType === "dunning") return 0;
  if (contactType === "poc") return 1;
  return 2;
}

/** Display order: dunning first (by email_rank nulls-last, then sms_rank
 *  nulls-last), then poc, then legacy/untyped. Pure — returns a new array. */
export function sortContactsForDisplay<T extends ClientContactDisplay>(contacts: T[]): T[] {
  return [...contacts].sort((a, b) => {
    const t = typeWeight(a.contact_type) - typeWeight(b.contact_type);
    if (t !== 0) return t;
    const e = nullsLast(a.email_rank, b.email_rank);
    if (e !== 0) return e;
    return nullsLast(a.sms_rank, b.sms_rank);
  });
}

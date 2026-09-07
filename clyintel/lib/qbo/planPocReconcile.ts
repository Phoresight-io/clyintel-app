// Pure decision core for the QBO PoC-contact reconcile (Contacts Brick 2).
//
// Given the PoC contacts that already exist (keyed by client), the synced
// clients, and their merged email/phone, decide which client_contacts rows to
// INSERT (a new PoC) vs UPDATE (an existing PoC's email/phone). No I/O — the
// caller (runQboSync) performs the actual .insert()/.update() with the result.
// Mirrors mergeClientContact.ts's pure-core pattern.
//
// NON-CLOBBER: existingPocIdByClientId is built from a contact_type='poc'-filtered
// read, so user-added dunning contacts are never present. This function can
// therefore never emit an update targeting a dunning contact — a re-sync cannot
// touch dunning rows. Proven in planPocReconcile.test.ts.
//
// No `@/` imports: alias-less vitest loads it directly (same as mergeClientContact).

export interface PocInsert {
  client_id: string;
  email: string | null;
  phone: string | null;
  is_primary: true;
  contact_type: "poc";
  email_rank: 1;
  sms_rank: 1 | null;
  voice_rank: 1 | null;
}

export interface PocUpdate {
  id: string;
  email: string | null;
  phone: string | null;
}

export interface PocReconcilePlan {
  inserts: PocInsert[];
  updates: PocUpdate[];
}

export function planPocReconcile(
  existingPocIdByClientId: Map<string, string>, // clientId → existing PoC contact id
  clientIdByQboId: Map<string, string>, // QBO Customer Id → clients.id
  mergedByQboId: Map<string, { email: string | null; phone: string | null }>,
): PocReconcilePlan {
  const inserts: PocInsert[] = [];
  const updates: PocUpdate[] = [];

  for (const [qboId, clientUuid] of clientIdByQboId) {
    const merged = mergedByQboId.get(qboId) ?? { email: null, phone: null };
    const existingId = existingPocIdByClientId.get(clientUuid);
    if (existingId) {
      // UPDATE email/phone only — never contact_type/ranks/opt_out_*/is_primary.
      updates.push({ id: existingId, email: merged.email, phone: merged.phone });
    } else if (merged.email && merged.email.trim() !== "") {
      // New PoC: tag type + ranks like the 0a backfill. email_rank is always 1
      // (insert only runs when email is present); sms/voice ranks are 1 only when
      // a phone exists, else null (contact doesn't participate there).
      const hasPhone = !!merged.phone && merged.phone.trim() !== "";
      inserts.push({
        client_id: clientUuid,
        email: merged.email,
        phone: merged.phone,
        is_primary: true,
        contact_type: "poc",
        email_rank: 1,
        sms_rank: hasPhone ? 1 : null,
        voice_rank: hasPhone ? 1 : null,
      });
    }
    // else: no PoC and no email → intentionally no contact row.
  }

  return { inserts, updates };
}

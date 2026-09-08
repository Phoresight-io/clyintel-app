// Pure helper for the contact editor's proactive rank-collision guard (Brick 4b).
//
// The DB enforces a partial UNIQUE index on (client_id, email_rank) WHERE
// email_rank IS NOT NULL — across ALL contact rows, poc AND dunning. So a
// dunning contact cannot take a rank that ANY contact already holds (a PoC sits
// at email_rank = 1, so rank 1 is unavailable to dunning contacts while a PoC
// exists). This computes the set of email_ranks already in use so the editor can
// disable them, matching the DB constraint exactly — the route's 23505 → 409 stays
// the backstop.
//
// excludeId lets EDIT mode keep the contact's own current rank selectable.
//
// No `@/` imports (leaf pure module, same convention as contactDisplay).

import type { ClientContactDisplay } from "./contactDisplay";

export function takenEmailRanks(
  contacts: ClientContactDisplay[],
  excludeId?: string,
): Set<number> {
  const taken = new Set<number>();
  for (const c of contacts) {
    if (excludeId !== undefined && c.id === excludeId) continue;
    if (c.email_rank !== null) taken.add(c.email_rank);
  }
  return taken;
}

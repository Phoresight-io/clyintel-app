import { describe, it, expect } from "vitest";
import { computeBalanceEvent, type ComputeBalanceEventInput } from "./computeBalanceEvent";

const base: ComputeBalanceEventInput = {
  subscriberId: "sub_1",
  invoiceId: "inv_1",
  source: "qbo",
  prevOutstandingCents: 10_000,
  newOutstandingCents: 4_000,
  reminderCount: 0,
  syncedAt: "2026-08-24T00:00:00.000Z",
};

describe("computeBalanceEvent", () => {
  it("prev == null → null (first sight, never bill an opening balance)", () => {
    expect(
      computeBalanceEvent({ ...base, prevOutstandingCents: null }),
    ).toBeNull();
  });

  it("new == prev → null (no-op re-sync)", () => {
    expect(
      computeBalanceEvent({ ...base, prevOutstandingCents: 5_000, newOutstandingCents: 5_000 }),
    ).toBeNull();
  });

  it("new > prev → null (balance rose, e.g. credit / new charge)", () => {
    expect(
      computeBalanceEvent({ ...base, prevOutstandingCents: 5_000, newOutstandingCents: 6_000 }),
    ).toBeNull();
  });

  it("new < prev → row with correct delta and passthrough context", () => {
    const row = computeBalanceEvent({ ...base, prevOutstandingCents: 10_000, newOutstandingCents: 4_000 });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      subscriber_id: "sub_1",
      invoice_id: "inv_1",
      source: "qbo",
      prev_outstanding_cents: 10_000,
      new_outstanding_cents: 4_000,
      delta_cents: 6_000,
      evidence: {
        prevOutstandingCents: 10_000,
        newOutstandingCents: 4_000,
        syncedAt: "2026-08-24T00:00:00.000Z",
      },
    });
  });

  it("full drop to zero → delta equals prev", () => {
    const row = computeBalanceEvent({ ...base, prevOutstandingCents: 3_900_00, newOutstandingCents: 0 });
    expect(row?.delta_cents).toBe(3_900_00);
    expect(row?.new_outstanding_cents).toBe(0);
  });

  it("reminderCount 0 → outreach_had_fired / fee_eligible both false", () => {
    const row = computeBalanceEvent({ ...base, reminderCount: 0 });
    expect(row?.outreach_had_fired).toBe(false);
    expect(row?.fee_eligible).toBe(false);
  });

  it("reminderCount > 0 → outreach_had_fired / fee_eligible both true (mirror for beta)", () => {
    const row = computeBalanceEvent({ ...base, reminderCount: 2 });
    expect(row?.outreach_had_fired).toBe(true);
    expect(row?.fee_eligible).toBe(true);
    // beta invariant: fee_eligible === outreach_had_fired
    expect(row?.fee_eligible).toBe(row?.outreach_had_fired);
  });

  it("guard invariant: any returned row satisfies new<prev AND delta==prev-new", () => {
    // Sweep a grid of prev/new/reminder combinations; every non-null result must
    // satisfy the DB CHECK constraints by construction.
    for (let prev = 0; prev <= 5; prev++) {
      for (let next = 0; next <= 5; next++) {
        for (const reminder of [0, 1, 3]) {
          for (const prevVal of [prev, null]) {
            const row = computeBalanceEvent({
              ...base,
              prevOutstandingCents: prevVal,
              newOutstandingCents: next,
              reminderCount: reminder,
            });
            if (row === null) continue;
            // balance_events_is_drop
            expect(row.new_outstanding_cents).toBeLessThan(row.prev_outstanding_cents);
            // balance_events_delta_matches
            expect(row.delta_cents).toBe(row.prev_outstanding_cents - row.new_outstanding_cents);
            expect(row.delta_cents).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

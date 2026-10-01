import { describe, it, expect } from "vitest";
import { computeBalanceEvent, type ComputeBalanceEventInput } from "./computeBalanceEvent";

const base: ComputeBalanceEventInput = {
  subscriberId: "sub_1",
  invoiceId: "inv_1",
  source: "qbo",
  prevOutstandingCents: 10_000,
  newOutstandingCents: 4_000,
  outreachStartedAt: null,
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

  it("REGRESSION: reminderCount is gone — booleans come only from outreach_started_at", () => {
    // Old behaviour read invoices.reminder_count (never written) → always false.
    // Now an outreach marker before the payment flips both booleans true.
    const row = computeBalanceEvent({
      ...base,
      outreachStartedAt: "2026-08-10T04:52:22.947Z",
      payment: { recordedAt: "2026-08-23T04:41:37Z", txnDate: "2026-08-23T00:00:00.000Z" },
    });
    expect(row?.outreach_had_fired).toBe(true);
    expect(row?.fee_eligible).toBe(true);
  });

  it("payment path: no marker → outreach_had_fired / fee_eligible both false", () => {
    const row = computeBalanceEvent({
      ...base,
      outreachStartedAt: null,
      payment: { recordedAt: "2026-08-23T04:41:37Z", txnDate: "2026-08-23T00:00:00.000Z" },
    });
    expect(row?.outreach_had_fired).toBe(false);
    expect(row?.fee_eligible).toBe(false);
  });

  it("payment path: marker AFTER the payment was recorded → both false (agrees with the billing gate)", () => {
    const row = computeBalanceEvent({
      ...base,
      outreachStartedAt: "2026-08-23T05:00:00.000Z",
      payment: { recordedAt: "2026-08-23T04:41:37Z", txnDate: "2026-08-23T00:00:00.000Z" },
    });
    expect(row?.outreach_had_fired).toBe(false);
    expect(row?.fee_eligible).toBe(false);
  });

  it("payment path: no times at all → fee_eligible false (fail closed)", () => {
    const row = computeBalanceEvent({
      ...base,
      outreachStartedAt: "2026-08-10T04:52:22.947Z",
      payment: { recordedAt: null, txnDate: null },
    });
    expect(row?.fee_eligible).toBe(false);
  });

  it("full-sync path (no payment): marker before syncedAt → outreach_had_fired true, fee_eligible ALWAYS false", () => {
    const row = computeBalanceEvent({ ...base, outreachStartedAt: "2026-08-10T00:00:00.000Z", payment: null });
    expect(row?.outreach_had_fired).toBe(true);
    expect(row?.fee_eligible).toBe(false);
  });

  it("full-sync path: marker after syncedAt or null → outreach_had_fired false", () => {
    expect(
      computeBalanceEvent({ ...base, outreachStartedAt: "2026-08-25T00:00:00.000Z" })?.outreach_had_fired,
    ).toBe(false);
    expect(computeBalanceEvent({ ...base, outreachStartedAt: null })?.outreach_had_fired).toBe(false);
  });

  it("evidence records the marker and payment times used", () => {
    const row = computeBalanceEvent({
      ...base,
      outreachStartedAt: "2026-08-10T04:52:22.947Z",
      payment: { recordedAt: "2026-08-23T04:41:37Z", txnDate: "2026-08-23T00:00:00.000Z" },
    });
    expect(row?.evidence).toEqual({
      prevOutstandingCents: 10_000,
      newOutstandingCents: 4_000,
      syncedAt: "2026-08-24T00:00:00.000Z",
      outreachStartedAt: "2026-08-10T04:52:22.947Z",
      paymentRecordedAt: "2026-08-23T04:41:37Z",
      paymentTxnDate: "2026-08-23T00:00:00.000Z",
    });
  });

  it("guard invariant: any returned row satisfies new<prev AND delta==prev-new", () => {
    // Sweep a grid of prev/new/marker combinations; every non-null result must
    // satisfy the DB CHECK constraints by construction.
    for (let prev = 0; prev <= 5; prev++) {
      for (let next = 0; next <= 5; next++) {
        for (const marker of [null, "2026-08-01T00:00:00.000Z"]) {
          for (const prevVal of [prev, null]) {
            const row = computeBalanceEvent({
              ...base,
              prevOutstandingCents: prevVal,
              newOutstandingCents: next,
              outreachStartedAt: marker,
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

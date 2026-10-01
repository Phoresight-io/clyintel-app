import { describe, it, expect } from "vitest";
import { computeBalanceEvent, outreachStartedBy, type ComputeBalanceEventInput } from "./computeBalanceEvent";

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
        outreachStartedAt: null,
      },
    });
  });

  it("full drop to zero → delta equals prev", () => {
    const row = computeBalanceEvent({ ...base, prevOutstandingCents: 3_900_00, newOutstandingCents: 0 });
    expect(row?.delta_cents).toBe(3_900_00);
    expect(row?.new_outstanding_cents).toBe(0);
  });

  it("no outreach marker (null) → outreach_had_fired / fee_eligible both false", () => {
    const row = computeBalanceEvent({ ...base, outreachStartedAt: null });
    expect(row?.outreach_had_fired).toBe(false);
    expect(row?.fee_eligible).toBe(false);
    expect(row?.evidence.outreachStartedAt).toBeNull();
  });

  it("marker BEFORE the detected drop → both true, marker recorded in evidence", () => {
    const row = computeBalanceEvent({ ...base, outreachStartedAt: "2026-08-10T04:52:22.947Z" });
    expect(row?.outreach_had_fired).toBe(true);
    expect(row?.fee_eligible).toBe(true);
    expect(row?.fee_eligible).toBe(row?.outreach_had_fired);
    expect(row?.evidence.outreachStartedAt).toBe("2026-08-10T04:52:22.947Z");
  });

  it("marker AFTER the detected drop → both false (outreach did not precede the payment)", () => {
    const row = computeBalanceEvent({ ...base, outreachStartedAt: "2026-08-24T00:00:00.001Z" });
    expect(row?.outreach_had_fired).toBe(false);
    expect(row?.fee_eligible).toBe(false);
    expect(row?.evidence.outreachStartedAt).toBe("2026-08-24T00:00:00.001Z");
  });

  it("marker EXACTLY at the detection instant → true (started 'by' the drop)", () => {
    const row = computeBalanceEvent({ ...base, outreachStartedAt: base.syncedAt });
    expect(row?.fee_eligible).toBe(true);
  });

  it("no drop → null regardless of the marker (the marker never manufactures an event)", () => {
    expect(
      computeBalanceEvent({ ...base, prevOutstandingCents: 5_000, newOutstandingCents: 5_000, outreachStartedAt: "2026-01-01T00:00:00.000Z" }),
    ).toBeNull();
  });

  it("guard invariant: any returned row satisfies new<prev AND delta==prev-new", () => {
    // Sweep a grid of prev/new/marker combinations; every non-null result must
    // satisfy the DB CHECK constraints by construction.
    for (let prev = 0; prev <= 5; prev++) {
      for (let next = 0; next <= 5; next++) {
        for (const marker of [null, "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]) {
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

describe("outreachStartedBy", () => {
  const cut = "2026-09-23T04:41:37.429Z";
  it("null marker → false", () => expect(outreachStartedBy(null, cut)).toBe(false));
  it("before / equal → true", () => {
    expect(outreachStartedBy("2026-09-10T04:52:22.947Z", cut)).toBe(true);
    expect(outreachStartedBy(cut, cut)).toBe(true);
  });
  it("after → false", () => expect(outreachStartedBy("2026-09-23T04:41:37.430Z", cut)).toBe(false));
  it("compares instants, not strings (Postgres '+00' offset form vs ISO Z)", () => {
    expect(outreachStartedBy("2026-09-10 04:52:22.947+00", cut)).toBe(true);
    expect(outreachStartedBy("2026-09-23 06:00:00+02", cut)).toBe(true); // = 04:00Z
  });
  it("unparseable marker or cutoff → false (fail closed)", () => {
    expect(outreachStartedBy("not-a-date", cut)).toBe(false);
    expect(outreachStartedBy("2026-09-10T04:52:22.947Z", "garbage")).toBe(false);
  });
});

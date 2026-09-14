import { describe, it, expect, vi } from "vitest";
import {
  checkCronAuth,
  parseQboPaymentEntities,
  summarizeResult,
  processWebhookEventRow,
  type RowHandler,
  type RowProcessDeps,
} from "./worker";

const NOW = "2026-07-01T00:00:00.000Z";

/** Build RowProcessDeps with a single 'qbo' handler whose collaborators are mocked. */
function makeDeps(over: {
  parseEntities?: RowHandler["parseEntities"];
  buildEvent?: RowHandler["buildEvent"];
  reconcile?: RowHandler["reconcile"];
  runCore?: RowProcessDeps["runCore"];
  handlers?: RowProcessDeps["handlers"];
}): RowProcessDeps {
  const handler: RowHandler = {
    parseEntities: over.parseEntities ?? (() => [{ realmId: "r1", paymentId: "p1" }]),
    buildEvent: over.buildEvent ?? vi.fn(async () => ({}) as never),
    reconcile: over.reconcile,
  };
  return {
    handlers: over.handlers ?? { qbo: handler },
    runCore: over.runCore ?? (async () => ({ status: "written", ledgerId: "l1", feeAmount: 1, band: "band1", rate: 0.22 })),
    nowIso: () => NOW,
  };
}

const row = (over: Partial<{ id: string; source: string; raw_payload: unknown; attempts: number }> = {}) => ({
  id: "row_1",
  source: "qbo",
  raw_payload: {},
  attempts: 0,
  ...over,
});

describe("checkCronAuth", () => {
  it("missing secret env → missing_secret", () => {
    expect(checkCronAuth("Bearer x", undefined)).toBe("missing_secret");
    expect(checkCronAuth("Bearer x", "")).toBe("missing_secret");
  });
  it("missing or wrong header → unauthorized", () => {
    expect(checkCronAuth(null, "s3cret")).toBe("unauthorized");
    expect(checkCronAuth("Bearer wrong", "s3cret")).toBe("unauthorized");
    expect(checkCronAuth("s3cret", "s3cret")).toBe("unauthorized"); // missing "Bearer " prefix
  });
  it("correct Bearer secret → ok", () => {
    expect(checkCronAuth("Bearer s3cret", "s3cret")).toBe("ok");
  });
});

describe("parseQboPaymentEntities", () => {
  it("collects Payment Create/Update, skips Invoice/Delete/other", () => {
    const payload = {
      eventNotifications: [
        {
          realmId: "9130347597",
          dataChangeEvent: {
            entities: [
              { name: "Payment", id: "500", operation: "Create" },
              { name: "Payment", id: "501", operation: "Update" },
              { name: "Payment", id: "502", operation: "Delete" }, // skip
              { name: "Invoice", id: "130", operation: "Create" }, // skip
            ],
          },
        },
      ],
    };
    expect(parseQboPaymentEntities(payload)).toEqual([
      { realmId: "9130347597", paymentId: "500" },
      { realmId: "9130347597", paymentId: "501" },
    ]);
  });
  it("returns [] for a non-object / missing eventNotifications", () => {
    expect(parseQboPaymentEntities(null)).toEqual([]);
    expect(parseQboPaymentEntities({})).toEqual([]);
    expect(parseQboPaymentEntities({ eventNotifications: [{ realmId: "r" }] })).toEqual([]);
  });
});

describe("summarizeResult", () => {
  it("maps each CaptureResult variant to compact text", () => {
    expect(summarizeResult({ status: "written", ledgerId: "l", feeAmount: 1, band: "b", rate: 0.2 })).toBe("written");
    expect(summarizeResult({ status: "duplicate", ledgerId: "l" })).toBe("duplicate");
    expect(summarizeResult({ status: "no_fee", reason: "no_outreach" })).toBe("no_fee:no_outreach");
    expect(summarizeResult({ status: "rejected", reason: "unknown_source" })).toBe("rejected:unknown_source");
  });
});

describe("processWebhookEventRow — state machine", () => {
  it("core returns 'written' → done, result 'written', processed_at set", async () => {
    const out = await processWebhookEventRow(row(), makeDeps({}));
    expect(out.update).toEqual({ status: "done", result: "written", processed_at: NOW });
    expect(out.outcomes).toEqual(["written"]);
  });

  it("core returns no_fee:no_outreach → done (NOT failed), reason carried", async () => {
    const out = await processWebhookEventRow(
      row(),
      makeDeps({ runCore: async () => ({ status: "no_fee", reason: "no_outreach" }) }),
    );
    expect(out.update).toEqual({ status: "done", result: "no_fee:no_outreach", processed_at: NOW });
  });

  it("throws at attempts 0→1 (<3) → failed, last_error set, NO processed_at", async () => {
    const out = await processWebhookEventRow(
      row({ attempts: 0 }),
      makeDeps({ buildEvent: async () => { throw new Error("QBO 500"); } }),
    );
    expect(out.update.status).toBe("failed");
    expect(out.update.attempts).toBe(1);
    expect(out.update.last_error).toBe("QBO 500");
    expect(out.update.processed_at).toBeUndefined();
  });

  it("throws at attempts 2→3 (>=3) → dead, processed_at set", async () => {
    const out = await processWebhookEventRow(
      row({ attempts: 2 }),
      makeDeps({ runCore: async () => { throw new Error("boom"); } }),
    );
    expect(out.update.status).toBe("dead");
    expect(out.update.attempts).toBe(3);
    expect(out.update.last_error).toBe("boom");
    expect(out.update.processed_at).toBe(NOW);
  });

  it("no qualifying Payment entity → done, result 'skipped:no_payment_entity'", async () => {
    const out = await processWebhookEventRow(row(), makeDeps({ parseEntities: () => [] }));
    expect(out.update).toEqual({ status: "done", result: "skipped:no_payment_entity", processed_at: NOW });
    expect(out.outcomes).toEqual(["skipped:no_payment_entity"]);
  });

  it("unknown source → failure path (failed at attempts 0→1), last_error set", async () => {
    const out = await processWebhookEventRow(
      row({ source: "stripe", attempts: 0 }),
      makeDeps({ handlers: {} }),
    );
    expect(out.update.status).toBe("failed");
    expect(out.update.attempts).toBe(1);
    expect(out.update.last_error).toMatch(/unknown source 'stripe'/);
  });

  it("multiple qualifying entities → joined result summary", async () => {
    let call = 0;
    const out = await processWebhookEventRow(
      row(),
      makeDeps({
        parseEntities: () => [
          { realmId: "r", paymentId: "p1" },
          { realmId: "r", paymentId: "p2" },
        ],
        runCore: async () =>
          ++call === 1
            ? { status: "written", ledgerId: "l", feeAmount: 1, band: "b", rate: 0.2 }
            : { status: "duplicate", ledgerId: "l" },
      }),
    );
    expect(out.update).toEqual({ status: "done", result: "written;duplicate", processed_at: NOW });
  });
});

describe("processWebhookEventRow — capture-time reconcile", () => {
  const RI = {
    subscriberId: "sub_1",
    qboInvoiceId: "49",
    invoiceFaceCents: 95475,
    invoiceBalanceCents: 0,
    dueDate: "2026-06-26",
  };
  const buildEvent = async () => ({ event: { source: "qbo" } as never, reconcileInput: RI });

  // The payment landed in QBO regardless of fee outcome, so reconcile runs on
  // every non-'rejected' capture and receives the reconcileInput from buildEvent.
  it.each([
    ["written", { status: "written", ledgerId: "l", feeAmount: 1, band: "b", rate: 0.2 }],
    ["duplicate", { status: "duplicate", ledgerId: "l" }],
    ["no_fee", { status: "no_fee", reason: "no_outreach" }],
  ] as const)("reconcile runs after a %s capture, with the reconcileInput", async (_label, coreResult) => {
    const reconcile = vi.fn(async () => ({ status: "reconciled" as const, balanceEventEmitted: true }));
    const out = await processWebhookEventRow(
      row(),
      makeDeps({ buildEvent, reconcile, runCore: async () => coreResult }),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(RI);
    expect(out.outcomes).toContain("reconcile:reconciled");
  });

  it("reconcile is SKIPPED on a 'rejected' capture (no trustworthy subscriber/invoice)", async () => {
    const reconcile = vi.fn(async () => ({ status: "reconciled" as const, balanceEventEmitted: true }));
    const out = await processWebhookEventRow(
      row(),
      makeDeps({ buildEvent, reconcile, runCore: async () => ({ status: "rejected", reason: "unknown_source" }) }),
    );
    expect(reconcile).not.toHaveBeenCalled();
    expect(out.update).toEqual({ status: "done", result: "rejected:unknown_source", processed_at: NOW });
  });

  it("invoice_not_found reconcile outcome is surfaced (not a failure)", async () => {
    const reconcile = vi.fn(async () => ({ status: "invoice_not_found" as const, balanceEventEmitted: false }));
    const out = await processWebhookEventRow(row(), makeDeps({ buildEvent, reconcile }));
    expect(out.update.status).toBe("done");
    expect(out.outcomes).toEqual(["written", "reconcile:invoice_not_found"]);
  });
});

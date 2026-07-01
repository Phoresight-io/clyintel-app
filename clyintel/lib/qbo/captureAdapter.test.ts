import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock every collaborator so the test exercises adapter orchestration only.
// Relative specifiers matter — alias-less vitest can't resolve "@/...".
vi.mock("../supabase", () => ({ getSupabase: vi.fn() }));
vi.mock("./tokens", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("./client", () => ({
  getPayment: vi.fn(),
  getInvoice: vi.fn(),
  linkedInvoiceIds: vi.fn(),
}));

import { buildCaptureEventFromPayment, resolveInvoicePastDue } from "./captureAdapter";
import { getSupabase } from "../supabase";
import { getValidAccessToken } from "./tokens";
import { getPayment, getInvoice, linkedInvoiceIds } from "./client";

const REALM = "realm_1";
const PAYMENT_ID = "500";

/** A thenable Supabase query-builder stub: .from().select().eq().eq() → result. */
function mockService(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR),
  };
  return { from: vi.fn(() => builder) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-path defaults; individual tests override as needed.
  vi.mocked(getSupabase).mockReturnValue(
    mockService({ data: [{ subscriber_id: "sub_1" }], error: null }) as never,
  );
  vi.mocked(getValidAccessToken).mockResolvedValue({ accessToken: "tok", realmId: REALM });
  vi.mocked(linkedInvoiceIds).mockReturnValue(["130"]);
  vi.mocked(getPayment).mockResolvedValue({
    Id: "500",
    TotalAmt: 1200,
    TxnDate: "2026-06-28",
    Line: [{ LinkedTxn: [{ TxnType: "Invoice", TxnId: "130" }] }],
  });
  vi.mocked(getInvoice).mockResolvedValue({
    Id: "130",
    TotalAmt: 1200,
    DueDate: "2026-05-01",
    Balance: 1200,
  });
});

describe("buildCaptureEventFromPayment", () => {
  it("happy path → fully-populated CaptureEvent with correct mapping", async () => {
    const event = await buildCaptureEventFromPayment(REALM, PAYMENT_ID);

    expect(event).toEqual({
      source: "qbo",
      sourcePaymentId: "500",
      sourceInvoiceId: "130",
      invoicePastDue: true, // DueDate 2026-05-01 < TxnDate 2026-06-28
      invoiceFaceValue: 1200, // dollars, not divided by 100
      dollarsRecovered: 1200,
      capturedAt: "2026-06-28T00:00:00.000Z",
      connectedAccountRef: REALM, // realmId, NOT subscriberId
    });

    // Provider filter is 'quickbooks'; token fetched with the resolved subscriber.
    expect(getValidAccessToken).toHaveBeenCalledWith("sub_1");
    expect(getPayment).toHaveBeenCalledWith(REALM, PAYMENT_ID, "tok");
    expect(getInvoice).toHaveBeenCalledWith(REALM, "130", "tok");
  });

  it("invoicePastDue false when DueDate >= TxnDate", async () => {
    vi.mocked(getInvoice).mockResolvedValue({ Id: "130", TotalAmt: 1200, DueDate: "2026-06-28" });
    const event = await buildCaptureEventFromPayment(REALM, PAYMENT_ID);
    expect(event.invoicePastDue).toBe(false);
  });

  it("invoicePastDue false when DueDate is null", async () => {
    vi.mocked(getInvoice).mockResolvedValue({ Id: "130", TotalAmt: 1200, DueDate: undefined });
    const event = await buildCaptureEventFromPayment(REALM, PAYMENT_ID);
    expect(event.invoicePastDue).toBe(false);
  });

  it("0 subscribers for realm → throws", async () => {
    vi.mocked(getSupabase).mockReturnValue(mockService({ data: [], error: null }) as never);
    await expect(buildCaptureEventFromPayment(REALM, PAYMENT_ID)).rejects.toThrow(
      /no subscriber for realmId realm_1/,
    );
  });

  it("multiple subscribers for realm → throws (ambiguous)", async () => {
    vi.mocked(getSupabase).mockReturnValue(
      mockService({ data: [{ subscriber_id: "sub_1" }, { subscriber_id: "sub_2" }], error: null }) as never,
    );
    await expect(buildCaptureEventFromPayment(REALM, PAYMENT_ID)).rejects.toThrow(
      /ambiguous subscriber for realmId realm_1/,
    );
  });

  it("payment links 0 invoices → throws", async () => {
    vi.mocked(linkedInvoiceIds).mockReturnValue([]);
    await expect(buildCaptureEventFromPayment(REALM, PAYMENT_ID)).rejects.toThrow(
      /payment 500 links no invoice/,
    );
  });

  it("payment links >1 invoices → uses the first and warns", async () => {
    vi.mocked(linkedInvoiceIds).mockReturnValue(["130", "131"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = await buildCaptureEventFromPayment(REALM, PAYMENT_ID);

    expect(getInvoice).toHaveBeenCalledWith(REALM, "130", "tok"); // first only
    expect(getInvoice).toHaveBeenCalledTimes(1);
    expect(event.sourceInvoiceId).toBe("130");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/multi-invoice split not yet implemented/);
  });

  it("realmId mismatch between webhook and token → throws", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ accessToken: "tok", realmId: "other_realm" });
    await expect(buildCaptureEventFromPayment(REALM, PAYMENT_ID)).rejects.toThrow(/realmId mismatch/);
  });
});

describe("resolveInvoicePastDue (pure helper)", () => {
  it("DueDate < TxnDate → true", () => {
    expect(resolveInvoicePastDue("2026-05-01", "2026-06-28")).toBe(true);
  });
  it("DueDate == TxnDate → false", () => {
    expect(resolveInvoicePastDue("2026-06-28", "2026-06-28")).toBe(false);
  });
  it("DueDate > TxnDate → false", () => {
    expect(resolveInvoicePastDue("2026-07-01", "2026-06-28")).toBe(false);
  });
  it("DueDate null/undefined → false", () => {
    expect(resolveInvoicePastDue(null, "2026-06-28")).toBe(false);
    expect(resolveInvoicePastDue(undefined, "2026-06-28")).toBe(false);
  });
});

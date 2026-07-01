import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { getPayment, getInvoice, linkedInvoiceIds } from "./client";

// Deterministic — global fetch is stubbed, no network. QBO_BASE_URL is env-derived
// (via constants.qboApiBaseUrl), so set it for the run and restore afterward.
const BASE = "https://sandbox-quickbooks.api.intuit.com";
const REALM = "9130347597";
const TOKEN = "super-secret-access-token";

let originalBase: string | undefined;

beforeAll(() => {
  originalBase = process.env.QBO_BASE_URL;
  process.env.QBO_BASE_URL = BASE;
});

afterAll(() => {
  if (originalBase === undefined) delete process.env.QBO_BASE_URL;
  else process.env.QBO_BASE_URL = originalBase;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

/** A minimal Response-like stub for a 2xx JSON body. */
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
/** A minimal Response-like stub for a non-2xx. */
const errStatus = (status: number) => ({ ok: false, status, json: async () => ({}) });

describe("qbo client", () => {
  it("getPayment: unwraps the { Payment } envelope; linkedInvoiceIds extracts the invoice id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        Payment: {
          Id: "500",
          TotalAmt: 1200,
          TxnDate: "2026-06-28",
          Line: [{ LinkedTxn: [{ TxnType: "Invoice", TxnId: "130" }] }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payment = await getPayment(REALM, "500", TOKEN);

    expect(payment.Id).toBe("500");
    expect(payment.TotalAmt).toBe(1200);
    expect(payment.TxnDate).toBe("2026-06-28");
    expect(linkedInvoiceIds(payment)).toEqual(["130"]);
  });

  it("getPayment: sends the correct URL + headers (Bearer token, Accept json)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ Payment: { Id: "500", TotalAmt: 1, TxnDate: "2026-01-01" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getPayment(REALM, "500", TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v3/company/${REALM}/payment/500`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers.Accept).toBe("application/json");
  });

  it("getInvoice: unwraps the { Invoice } envelope with DueDate + Balance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        Invoice: { Id: "130", TotalAmt: 1200, DueDate: "2026-05-01", Balance: 1200 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const invoice = await getInvoice(REALM, "130", TOKEN);

    expect(invoice.Id).toBe("130");
    expect(invoice.TotalAmt).toBe(1200);
    expect(invoice.DueDate).toBe("2026-05-01");
    expect(invoice.Balance).toBe(1200);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v3/company/${REALM}/invoice/130`);
  });

  it("non-2xx (404): throws with status + entity id, and never the access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errStatus(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInvoice(REALM, "999", TOKEN)).rejects.toThrow(/404/);
    // Re-run to inspect the message for the id and the absence of the token.
    const err = await getInvoice(REALM, "999", TOKEN).catch((e: Error) => e);
    expect((err as Error).message).toContain("999");
    expect((err as Error).message).toContain("Invoice");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("401: throws an auth-failure-flavored message (no refresh attempted here)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errStatus(401));
    vi.stubGlobal("fetch", fetchMock);

    const err = await getPayment(REALM, "500", TOKEN).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).toMatch(/unauthorized|revoked|auth/i);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("linkedInvoiceIds: ignores non-Invoice linked txns and handles missing Line", async () => {
    expect(
      linkedInvoiceIds({
        Id: "1",
        TotalAmt: 1,
        TxnDate: "2026-01-01",
        Line: [
          { LinkedTxn: [{ TxnType: "Invoice", TxnId: "130" }, { TxnType: "CreditMemo", TxnId: "77" }] },
          { LinkedTxn: [{ TxnType: "Invoice", TxnId: "131" }] },
          {},
        ],
      }),
    ).toEqual(["130", "131"]);

    expect(linkedInvoiceIds({ Id: "1", TotalAmt: 1, TxnDate: "2026-01-01" })).toEqual([]);
  });
});

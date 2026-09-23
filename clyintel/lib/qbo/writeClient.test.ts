import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { qboPostEntity } from "./writeClient";

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

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const errStatus = (status: number) => ({ ok: false, status, json: async () => ({}) });

describe("qbo writeClient", () => {
  it("POST success → unwraps the single { Payment } envelope and attaches raw", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ Payment: { Id: "PAY_1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const created = await qboPostEntity<{ Id: string }>(REALM, "payment", TOKEN, { TotalAmt: 5 });

    expect(created.Id).toBe("PAY_1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v3/company/${REALM}/payment`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("401 → force-refresh → retry succeeds → returns data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errStatus(401))
      .mockResolvedValueOnce(okJson({ Payment: { Id: "PAY_2" } }));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn().mockResolvedValue("fresh-access-token");

    const created = await qboPostEntity<{ Id: string }>(
      REALM,
      "payment",
      TOKEN,
      { TotalAmt: 5 },
      refresh,
    );

    expect(created.Id).toBe("PAY_2");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-access-token");
  });

  it("401 → force-refresh → retry still 401 → throws auth error (no token leak)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errStatus(401));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn().mockResolvedValue("fresh-access-token");

    const err = await qboPostEntity(REALM, "payment", TOKEN, {}, refresh).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).toMatch(/unauthorized|revoked|auth/i);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("401 with NO refresh callback → throws immediately, no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errStatus(401));
    vi.stubGlobal("fetch", fetchMock);

    const err = await qboPostEntity(REALM, "payment", TOKEN, {}).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

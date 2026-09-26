import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable stub of the service-role client's rev_share_ledger query.
const result: { data: unknown; error: unknown } = { data: null, error: null };
const calls: { method: string; args: unknown[] }[] = [];
const builder: Record<string, unknown> = {};
for (const m of ["from", "select", "eq", "gte", "order"]) {
  builder[m] = (...args: unknown[]) => {
    calls.push({ method: m, args });
    return builder;
  };
}
builder.range = (...args: unknown[]) => {
  calls.push({ method: "range", args });
  return Promise.resolve(result);
};

vi.mock("@/lib/supabase", () => ({ getSupabase: () => builder }));

const { getRecoveryYTD } = await import("@/lib/data");

const NOW = new Date("2026-09-26T12:00:00Z");

describe("getRecoveryYTD", () => {
  beforeEach(() => {
    calls.length = 0;
    result.data = null;
    result.error = null;
  });

  it("read error → { ok: false }", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    result.error = { message: "boom" };
    expect(await getRecoveryYTD("sub-1", [], NOW)).toEqual({ ok: false });
  });

  it("scopes the read to the subscriber and the UTC YTD window", async () => {
    result.data = [{ id: "l1", source_invoice_id: "49", dollars_recovered: 954.75, captured_at: "2026-09-13T00:00:00Z" }];
    const r = await getRecoveryYTD("sub-1", [{ external_id: "49", client_id: "c1" }], NOW);
    expect(r).toEqual({ ok: true, totalCents: 95475, byClientCents: { c1: 95475 } });
    expect(calls).toContainEqual({ method: "from", args: ["rev_share_ledger"] });
    expect(calls).toContainEqual({ method: "eq", args: ["subscriber_id", "sub-1"] });
    expect(calls).toContainEqual({ method: "gte", args: ["captured_at", "2026-01-01T00:00:00.000Z"] });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Endpoint shell tests: auth gate and wiring. The decision rules are covered by
// lib/score/scoreClient.test.ts.
const getUser = vi.fn();
vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServer: async () => ({ auth: { getUser } }),
}));
const upsert = vi.fn(async () => ({ error: null }));
const owned = { value: true };
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "lt", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: table === "clients" && owned.value ? { id: "x" } : null, error: null });
      // invoices / communications resolve when awaited directly
      b.then = (resolve: (v: unknown) => void) =>
        resolve({
          data:
            table === "invoices"
              ? [{ id: "i1", status: "overdue", due_date: "2026-01-01", issue_date: "2025-12-01", created_at: "2025-12-01T00:00:00Z", amount_cents: 1000, amount_outstanding_cents: 1000 }]
              : [],
          error: null,
        });
      b.upsert = upsert;
      return b;
    },
  }),
}));

import { GET, POST } from "./route";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: CLIENT }) };

beforeEach(() => {
  vi.clearAllMocks();
  owned.value = true;
  getUser.mockResolvedValue({ data: { user: { id: "22222222-2222-4222-8222-222222222222" } }, error: null });
});

describe("clients/[id]/score route", () => {
  it("no session → 401 on GET and POST, nothing written", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET({} as never, ctx)).status).toBe(401);
    expect((await POST({} as never, ctx)).status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("unowned client → 404, nothing written", async () => {
    owned.value = false;
    expect((await POST({} as never, ctx)).status).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("GET is a dry run: 200 with the result, nothing written", async () => {
    const res = await GET({} as never, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("scored");
    expect(body.written).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("POST upserts once with onConflict client_id,score_month", async () => {
    const res = await POST({} as never, ctx);
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0] as unknown[])[1]).toEqual({ onConflict: "client_id,score_month" });
  });
});

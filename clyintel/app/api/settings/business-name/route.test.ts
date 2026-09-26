import { describe, it, expect, vi, beforeEach } from "vitest";

let authUser: { id: string } | null = { id: "sub-1" };
vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServer: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: authUser }, error: null }) },
  })),
}));

const writes: { table: string; patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];
let updateError: { message: string } | null = null;
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      let patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => {
          patch = p;
          return b;
        },
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return b;
        },
        then: (resolve: (v: unknown) => void) => {
          writes.push({ table, patch, filters });
          resolve({ error: updateError });
        },
      };
      return b;
    },
  }),
}));

import { POST } from "./route";

const req = (body: unknown) =>
  ({ json: async () => (body === "bad-json" ? Promise.reject(new Error("x")) : body) }) as never;

beforeEach(() => {
  authUser = { id: "sub-1" };
  updateError = null;
  writes.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/settings/business-name", () => {
  it("trims and saves to the logged-in subscriber's OWN row only", async () => {
    const res = await POST(req({ business_name: "  Ocean View Landscaping  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ business_name: "Ocean View Landscaping" });
    expect(writes).toEqual([
      { table: "subscribers", patch: { business_name: "Ocean View Landscaping" }, filters: [["id", "sub-1"]] },
    ]);
  });

  it("scoped by the session user, never a body-supplied id", async () => {
    authUser = { id: "sub-2" };
    await POST(req({ business_name: "Acme", id: "sub-1", subscriber_id: "sub-1" }));
    expect(writes[0].filters).toEqual([["id", "sub-2"]]);
  });

  it.each([{ business_name: "" }, { business_name: "   " }, {}, { business_name: 7 }])(
    "empty / missing / non-string %j → 400, nothing written",
    async (body) => {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      expect(writes).toHaveLength(0);
    },
  );

  it("over 120 characters → 400, nothing written", async () => {
    const res = await POST(req({ business_name: "a".repeat(121) }));
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("not authenticated → 401, nothing written", async () => {
    authUser = null;
    expect((await POST(req({ business_name: "Acme" }))).status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it("invalid JSON → 400; DB error → 500", async () => {
    expect((await POST(req("bad-json"))).status).toBe(400);
    updateError = { message: "boom" };
    expect((await POST(req({ business_name: "Acme" }))).status).toBe(500);
  });
});

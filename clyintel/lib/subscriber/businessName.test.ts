import { describe, it, expect, vi } from "vitest";
import { prefillBusinessNameFromQbo, validateBusinessName, BUSINESS_NAME_MAX } from "./businessName";

describe("validateBusinessName", () => {
  it("trims", () => {
    expect(validateBusinessName("  Ocean View Landscaping  ")).toEqual({ ok: true, name: "Ocean View Landscaping" });
  });
  it.each(["", "   ", "\n\t", undefined, null, 42])("rejects empty / non-string %j", (v) => {
    expect(validateBusinessName(v).ok).toBe(false);
  });
  it("max 120 characters (after trimming)", () => {
    expect(validateBusinessName("a".repeat(BUSINESS_NAME_MAX)).ok).toBe(true);
    expect(validateBusinessName(`  ${"a".repeat(BUSINESS_NAME_MAX)}  `).ok).toBe(true);
    expect(validateBusinessName("a".repeat(BUSINESS_NAME_MAX + 1))).toEqual({
      ok: false,
      reason: "Business name must be 120 characters or fewer.",
    });
  });
});

// Fake service client: one subscribers row; records the guarded update.
function fakeService(current: string | null, opts: { updateRows?: number; readError?: boolean } = {}) {
  const updates: { patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const service = {
    from: () => {
      let patch: Record<string, unknown> | null = null;
      const filters: [string, unknown][] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return b;
        },
        update: (p: Record<string, unknown>) => {
          patch = p;
          return b;
        },
        maybeSingle: async () =>
          opts.readError
            ? { data: null, error: { message: "boom" } }
            : { data: current === null ? null : { business_name: current }, error: null },
        then: (resolve: (v: unknown) => void) => {
          if (patch) updates.push({ patch, filters });
          const n = opts.updateRows ?? 1;
          resolve({ data: Array.from({ length: n }, () => ({ id: "sub-1" })), error: null });
        },
      };
      return b;
    },
  } as never;
  return { service, updates };
}

describe("prefillBusinessNameFromQbo", () => {
  it("empty name → set to QBO CompanyName (trimmed), guarded on the value read", async () => {
    const { service, updates } = fakeService("");
    const r = await prefillBusinessNameFromQbo(service, "sub-1", async () => "  Ocean View LLC ");
    expect(r).toEqual({ action: "set", name: "Ocean View LLC" });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ business_name: "Ocean View LLC" });
    expect(updates[0].filters).toEqual(
      expect.arrayContaining([
        ["id", "sub-1"],
        ["business_name", ""],
      ]),
    );
  });

  it("whitespace-only name counts as empty", async () => {
    const { service, updates } = fakeService("   ");
    expect((await prefillBusinessNameFromQbo(service, "sub-1", async () => "Acme")).action).toBe("set");
    expect(updates[0].filters).toContainEqual(["business_name", "   "]);
  });

  it("non-empty name → NEVER overwritten; CompanyInfo not even fetched", async () => {
    const { service, updates } = fakeService("My Chosen Brand");
    const fetchName = vi.fn(async () => "Legal Name LLC");
    expect(await prefillBusinessNameFromQbo(service, "sub-1", fetchName)).toEqual({ action: "kept_existing" });
    expect(fetchName).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("name saved concurrently in Settings (guarded update hits 0 rows) → kept_existing", async () => {
    const { service } = fakeService("", { updateRows: 0 });
    expect(await prefillBusinessNameFromQbo(service, "sub-1", async () => "Acme")).toEqual({ action: "kept_existing" });
  });

  it("CompanyInfo throws → { action: 'error' }, no update, never throws", async () => {
    const { service, updates } = fakeService("");
    const r = await prefillBusinessNameFromQbo(service, "sub-1", async () => {
      throw new Error("QBO CompanyInfo fetch failed: HTTP 500");
    });
    expect(r).toEqual({ action: "error", reason: "QBO CompanyInfo fetch failed: HTTP 500" });
    expect(updates).toHaveLength(0);
  });

  it("no usable CompanyName (null / blank) → no_company_name, no update", async () => {
    for (const v of [null, "   "]) {
      const { service, updates } = fakeService("");
      expect(await prefillBusinessNameFromQbo(service, "sub-1", async () => v)).toEqual({ action: "no_company_name" });
      expect(updates).toHaveLength(0);
    }
  });

  it("subscriber read error / missing row → error, no update", async () => {
    expect((await prefillBusinessNameFromQbo(fakeService("", { readError: true }).service, "s", async () => "A")).action).toBe("error");
    expect((await prefillBusinessNameFromQbo(fakeService(null).service, "s", async () => "A")).action).toBe("error");
  });
});

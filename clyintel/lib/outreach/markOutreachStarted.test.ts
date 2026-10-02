import { describe, it, expect, vi, beforeEach } from "vitest";
import { markOutreachStarted } from "./markOutreachStarted";

// Stateful fake honoring exactly the chain the helper issues:
//   from("invoices").update({ outreach_started_at }).eq("id", …).is("outreach_started_at", null).select("id")
// The .is(…, null) predicate is applied for real, so write-once is exercised, not assumed.
function makeDb(rows: Record<string, { outreach_started_at: string | null }>) {
  const calls: Array<{ table: string; payload: unknown; eqs: [string, unknown][]; iss: [string, unknown][] }> = [];
  const from = (table: string) => {
    const ctx = { table, payload: null as unknown, eqs: [] as [string, unknown][], iss: [] as [string, unknown][] };
    calls.push(ctx);
    const resolve = () => {
      const id = ctx.eqs.find(([c]) => c === "id")?.[1] as string;
      const row = rows[id];
      const nullGuard = ctx.iss.some(([c, v]) => c === "outreach_started_at" && v === null);
      if (!row || (nullGuard && row.outreach_started_at !== null)) {
        return Promise.resolve({ data: [], error: null });
      }
      row.outreach_started_at = (ctx.payload as { outreach_started_at: string }).outreach_started_at;
      return Promise.resolve({ data: [{ id }], error: null });
    };
    const b: Record<string, unknown> = {
      update: (p: unknown) => { ctx.payload = p; return b; },
      eq: (c: string, v: unknown) => { ctx.eqs.push([c, v]); return b; },
      is: (c: string, v: unknown) => { ctx.iss.push([c, v]); return b; },
      select: () => resolve(),
    };
    return b;
  };
  return { client: { from } as never, rows, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("markOutreachStarted", () => {
  it("stamps an unstamped invoice with the given timestamp", async () => {
    const db = makeDb({ inv1: { outreach_started_at: null } });
    const res = await markOutreachStarted(db.client, "inv1", "2026-09-10T04:52:22.947Z", "email");
    expect(res).toBe("stamped");
    expect(db.rows.inv1.outreach_started_at).toBe("2026-09-10T04:52:22.947Z");
    // The write is guarded by IS NULL (race-safe write-once), scoped by id.
    expect(db.calls[0]).toMatchObject({
      table: "invoices",
      payload: { outreach_started_at: "2026-09-10T04:52:22.947Z" },
      eqs: [["id", "inv1"]],
      iss: [["outreach_started_at", null]],
    });
  });

  it("WRITE-ONCE: a second call never overwrites the first stamp", async () => {
    const db = makeDb({ inv1: { outreach_started_at: null } });
    await markOutreachStarted(db.client, "inv1", "2026-09-10T04:52:22.947Z", "email");
    const second = await markOutreachStarted(db.client, "inv1", "2026-09-26T21:47:01.611Z", "voice");
    expect(second).toBe("already_stamped");
    expect(db.rows.inv1.outreach_started_at).toBe("2026-09-10T04:52:22.947Z");
  });

  it("DB error → returns 'error', logs loudly, never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      from: () => {
        const b: Record<string, unknown> = {
          update: () => b,
          eq: () => b,
          is: () => b,
          select: async () => ({ data: null, error: { message: "boom" } }),
        };
        return b;
      },
    } as never;
    await expect(markOutreachStarted(client, "inv1", "2026-09-10T00:00:00.000Z", "voice")).resolves.toBe("error");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("FAILED to stamp invoice inv1"));
  });

  it("thrown client error → returns 'error', never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = { from: () => { throw new Error("network"); } } as never;
    await expect(markOutreachStarted(client, "inv1", "2026-09-10T00:00:00.000Z", "email")).resolves.toBe("error");
    expect(err).toHaveBeenCalled();
  });
});

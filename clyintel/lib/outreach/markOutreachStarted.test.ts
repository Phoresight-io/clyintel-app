import { describe, it, expect, vi } from "vitest";
import { markOutreachStarted } from "./markOutreachStarted";

// Stateful single-invoice fake honoring exactly the write-once update:
//   .from("invoices").update(p).eq("id").eq("subscriber_id").is("outreach_started_at", null)
function makeDb(initial: string | null, opts: { error?: string; throws?: boolean } = {}) {
  const state = { outreach_started_at: initial, updates: 0 };
  const from = vi.fn(() => {
    let payload: Record<string, unknown> = {};
    const filters: Array<[string, string, unknown]> = [];
    const b: Record<string, unknown> = {
      update: (p: Record<string, unknown>) => { payload = p; return b; },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b; },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return b; },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        if (opts.throws) return Promise.reject(new Error("network")).then(onF, onR);
        if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } }).then(onF, onR);
        const guarded = filters.some(([k, c, v]) => k === "is" && c === "outreach_started_at" && v === null);
        if (!guarded || state.outreach_started_at === null) {
          state.outreach_started_at = payload.outreach_started_at as string;
          state.updates++;
        }
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  });
  return { client: { from } as never, state, from };
}

const ARGS = { subscriberId: "sub-1", invoiceId: "inv-1" };

describe("markOutreachStarted (write-once)", () => {
  it("null marker → stamped", async () => {
    const db = makeDb(null);
    await markOutreachStarted(db.client, { ...ARGS, startedAt: "2026-09-10T04:52:22.947Z" });
    expect(db.state.outreach_started_at).toBe("2026-09-10T04:52:22.947Z");
  });

  it("a SECOND outreach does NOT overwrite the earlier stamp", async () => {
    const db = makeDb(null);
    await markOutreachStarted(db.client, { ...ARGS, startedAt: "2026-09-10T04:52:22.947Z" });
    await markOutreachStarted(db.client, { ...ARGS, startedAt: "2026-09-26T16:48:54.812Z" });
    expect(db.state.outreach_started_at).toBe("2026-09-10T04:52:22.947Z");
    expect(db.state.updates).toBe(1);
  });

  it("DB error → logged loudly, never thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb(null, { error: "permission denied" });
    await expect(markOutreachStarted(db.client, { ...ARGS, startedAt: "2026-09-10T00:00:00Z" })).resolves.toBeUndefined();
    expect(err.mock.calls[0][0]).toMatch(/FAILED to stamp invoices\.outreach_started_at/);
    err.mockRestore();
  });

  it("thrown client error → logged, never thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb(null, { throws: true });
    await expect(markOutreachStarted(db.client, { ...ARGS, startedAt: "2026-09-10T00:00:00Z" })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

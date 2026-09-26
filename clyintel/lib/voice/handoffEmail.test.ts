import { describe, it, expect } from "vitest";
import { createHandoffPort, parseHandoffMode } from "./handoffEmail";

// The reused helpers: the mode fence and the DB-enforced per-call claim. The
// orchestrator that used to live here (#140's post-call trigger) was removed; the
// in-call tool's orchestrator is tested in sendPaymentEmailForCall.test.ts.

const CALL_ID = "vc-1";
const NOW = "2026-09-25T22:00:00.000Z";

describe("parseHandoffMode — mode fence (fail closed)", () => {
  it.each([undefined, null, "", "LIVE", "Dry_Run", "garbage", "true"])("mode %j → null (OFF)", (raw) => {
    expect(parseHandoffMode(raw)).toBeNull();
  });

  it("only exact 'dry_run' / 'live' enable it", () => {
    expect(parseHandoffMode("dry_run")).toBe("dry_run");
    expect(parseHandoffMode("live")).toBe("live");
  });
});

describe("createHandoffPort — the DB-enforced claim", () => {
  function fakeDb(rowsReturned: number, single: unknown = null) {
    const calls: { op: string; args: unknown[] }[] = [];
    const b: Record<string, unknown> = {};
    b.maybeSingle = async () => ({ data: single, error: null });
    for (const m of ["update", "eq", "is", "select"]) {
      b[m] = (...args: unknown[]) => {
        calls.push({ op: m, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: Array.from({ length: rowsReturned }, () => ({ id: CALL_ID })), error: null });
    return { db: { from: () => b } as never, calls };
  }

  it("claim is update … where id = ? AND handoff_email_status IS NULL; 1 row → true", async () => {
    const { db, calls } = fakeDb(1);
    const ok = await createHandoffPort(db).claimOrRecord(CALL_ID, { status: "claimed" }, NOW);
    expect(ok).toBe(true);
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({
      handoff_email_status: "claimed",
      handoff_email_reason: null,
      handoff_email_at: NOW,
    });
    expect(calls).toContainEqual({ op: "eq", args: ["id", CALL_ID] });
    expect(calls).toContainEqual({ op: "is", args: ["handoff_email_status", null] });
  });

  it("0 rows (already claimed/recorded) → false", async () => {
    const { db } = fakeDb(0);
    expect(await createHandoffPort(db).claimOrRecord(CALL_ID, { status: "skipped", reason: "no_invoice" }, NOW)).toBe(false);
  });

  it("finalize only moves a row that is still 'claimed'", async () => {
    const { db, calls } = fakeDb(1);
    await createHandoffPort(db).finalize(CALL_ID, { status: "sent", reason: null, communicationId: "comm-1" });
    expect(calls).toContainEqual({ op: "eq", args: ["handoff_email_status", "claimed"] });
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({
      handoff_email_status: "sent",
      handoff_email_reason: null,
      handoff_email_communication_id: "comm-1",
    });
  });

  it("release is update … set NULL where id = ? AND handoff_email_status = 'claimed'", async () => {
    const { db, calls } = fakeDb(1);
    await createHandoffPort(db).release(CALL_ID);
    expect(calls.find((c) => c.op === "update")!.args[0]).toEqual({
      handoff_email_status: null,
      handoff_email_reason: null,
      handoff_email_at: null,
    });
    expect(calls).toContainEqual({ op: "eq", args: ["id", CALL_ID] });
    expect(calls).toContainEqual({ op: "eq", args: ["handoff_email_status", "claimed"] });
  });

  it("loadPriorSend returns the claim status and the linked communication's to_address", async () => {
    const { db } = fakeDb(0, { handoff_email_status: "sent", communications: { to_address: "ap@acme.com" } });
    expect(await createHandoffPort(db).loadPriorSend(CALL_ID)).toEqual({ status: "sent", toAddress: "ap@acme.com" });
  });
});

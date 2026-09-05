import { describe, it, expect } from "vitest";
import { parseRunRequest } from "./parseRunRequest";

describe("parseRunRequest", () => {
  it("body-less / empty → dry-run, unfenced (byte-identical to pre-C4a default)", () => {
    for (const raw of ["", "   ", "\n"]) {
      expect(parseRunRequest(raw)).toEqual({ ok: true, mode: "dry_run", subscriberId: undefined });
    }
  });

  it("{} → dry-run, unfenced", () => {
    expect(parseRunRequest("{}")).toEqual({ ok: true, mode: "dry_run", subscriberId: undefined });
  });

  it("{ subscriberId } alone → dry-run + fenced (mode defaults to dry_run)", () => {
    expect(parseRunRequest(JSON.stringify({ subscriberId: "sub-1" }))).toEqual({
      ok: true,
      mode: "dry_run",
      subscriberId: "sub-1",
    });
  });

  it("{ mode:'live', subscriberId } → live threaded + fence applied", () => {
    expect(parseRunRequest(JSON.stringify({ mode: "live", subscriberId: "sub-9" }))).toEqual({
      ok: true,
      mode: "live",
      subscriberId: "sub-9",
    });
  });

  it("{ mode:'dry_run', subscriberId } → dry-run + fenced", () => {
    expect(parseRunRequest(JSON.stringify({ mode: "dry_run", subscriberId: "sub-2" }))).toEqual({
      ok: true,
      mode: "dry_run",
      subscriberId: "sub-2",
    });
  });

  it("{ mode:'live' } with NO subscriberId → 400 (live must be fenced)", () => {
    expect(parseRunRequest(JSON.stringify({ mode: "live" }))).toEqual({
      ok: false,
      status: 400,
      error: "live runs must be fenced to a subscriberId",
    });
  });

  it("malformed JSON → 400 (never a silent live default)", () => {
    const r = parseRunRequest("{not json");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 400, error: "invalid JSON body" });
  });

  it("non-object JSON (array / primitive) → 400", () => {
    expect(parseRunRequest("[1,2]")).toMatchObject({ ok: false, status: 400 });
    expect(parseRunRequest("42")).toMatchObject({ ok: false, status: 400 });
    expect(parseRunRequest("null")).toMatchObject({ ok: false, status: 400 });
  });

  it("invalid mode value → 400", () => {
    expect(parseRunRequest(JSON.stringify({ mode: "LIVE" }))).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(parseRunRequest(JSON.stringify({ mode: "test" }))).toMatchObject({ ok: false, status: 400 });
  });

  it("empty / non-string subscriberId → 400", () => {
    expect(parseRunRequest(JSON.stringify({ subscriberId: "" }))).toMatchObject({ ok: false, status: 400 });
    expect(parseRunRequest(JSON.stringify({ subscriberId: "  " }))).toMatchObject({ ok: false, status: 400 });
    expect(parseRunRequest(JSON.stringify({ subscriberId: 123 }))).toMatchObject({ ok: false, status: 400 });
  });
});

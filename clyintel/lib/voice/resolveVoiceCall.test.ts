import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractVapiCallId, extractVoiceCallId, resolveVoiceCall, serializeError } from "./resolveVoiceCall";

const hdr = (h: Record<string, string> = {}) => ({ headers: { get: (k: string) => h[k.toLowerCase()] ?? null } });

describe("extractVoiceCallId", () => {
  it("top-level call.metadata first, then artifact.variableValues, then artifact.variables", () => {
    expect(extractVoiceCallId({ call: { metadata: { voiceCallId: "a" } } })).toBe("a");
    expect(extractVoiceCallId({ artifact: { variableValues: { call: { metadata: { voiceCallId: "b" } } } } })).toBe("b");
    expect(extractVoiceCallId({ artifact: { variables: { call: { metadata: { voiceCallId: "c" } } } } })).toBe("c");
    expect(
      extractVoiceCallId({
        call: { metadata: { voiceCallId: "a" } },
        artifact: { variableValues: { call: { metadata: { voiceCallId: "b" } } } },
      }),
    ).toBe("a");
    expect(extractVoiceCallId(undefined)).toBeNull();
    expect(extractVoiceCallId({ call: { id: "x" } })).toBeNull();
  });
});

describe("extractVapiCallId", () => {
  it("body call.id first, then artifact copies, then the X-Call-Id header", () => {
    expect(extractVapiCallId({ call: { id: "v1" } }, hdr({ "x-call-id": "h" }))).toBe("v1");
    expect(extractVapiCallId({ artifact: { variables: { call: { id: "v2" } } } }, hdr())).toBe("v2");
    expect(extractVapiCallId({}, hdr({ "x-call-id": "h" }))).toBe("h");
    expect(extractVapiCallId(undefined, hdr())).toBeNull();
  });
});

describe("resolveVoiceCall", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // rows keyed by the column the lookup filters on.
  function db(rows: { byId?: string | null; byVapi?: string | null; error?: boolean }) {
    const lookups: string[] = [];
    return {
      lookups,
      service: {
        from: () => {
          let col = "";
          const b: Record<string, unknown> = {
            select: () => b,
            eq: (c: string) => {
              col = c;
              lookups.push(c);
              return b;
            },
            maybeSingle: async () => {
              if (rows.error) return { data: null, error: { message: "boom" } };
              const id = col === "id" ? rows.byId : rows.byVapi;
              return { data: id ? { id } : null, error: null };
            },
          };
          return b;
        },
      } as never,
    };
  }

  it("metadata id matches → that row, no vapi lookup", async () => {
    const d = db({ byId: "vc-1" });
    expect(await resolveVoiceCall(d.service, "vc-1", "vapi-1")).toEqual({ id: "vc-1", via: "metadata.voiceCallId" });
    expect(d.lookups).toEqual(["id"]);
  });

  it("no metadata match → falls back to vapi_call_id", async () => {
    const d = db({ byId: null, byVapi: "vc-2" });
    expect(await resolveVoiceCall(d.service, "stale", "vapi-1")).toEqual({ id: "vc-2", via: "call.id→vapi_call_id" });
    expect(d.lookups).toEqual(["id", "vapi_call_id"]);
  });

  it("nothing resolves / read errors → nulls, never throws", async () => {
    expect(await resolveVoiceCall(db({}).service, null, null)).toEqual({ id: null, via: null });
    expect(await resolveVoiceCall(db({ error: true }).service, "vc-1", "vapi-1")).toEqual({ id: null, via: null });
  });
});

describe("serializeError", () => {
  it("pulls PostgREST fields; falls back to JSON / String", () => {
    expect(serializeError({ message: "m", code: "c" })).toBe(JSON.stringify({ message: "m", code: "c" }));
    expect(serializeError({ x: 1 })).toBe('{"x":1}');
    expect(serializeError("plain")).toBe("plain");
  });
});

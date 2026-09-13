import { describe, it, expect } from "vitest";
import { isSweepEnabled, isChargingEnabled, getMinChargeCents, DEFAULT_MIN_CHARGE_CENTS } from "./config";

// Stub that returns a fixed jsonb value for whatever key is read (records the key).
function makeConfig(value: unknown) {
  const keys: string[] = [];
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (_col: string, v: unknown) => {
    keys.push(v as string);
    return b;
  };
  b.maybeSingle = () => b;
  b.then = (onF: (v: { data: unknown; error: null }) => unknown) =>
    Promise.resolve({ data: value === undefined ? null : { value }, error: null }).then(onF);
  return { client: { from: () => b } as never, keys };
}

describe("settlement config flags (two-flag rollout, fail-safe)", () => {
  it("isSweepEnabled reads settlement_sweep_enabled; true only for explicit true", async () => {
    const on = makeConfig(true);
    expect(await isSweepEnabled(on.client)).toBe(true);
    expect(on.keys).toContain("settlement_sweep_enabled");

    expect(await isSweepEnabled(makeConfig(false).client)).toBe(false);
    expect(await isSweepEnabled(makeConfig(undefined).client)).toBe(false); // unset ⇒ off
    expect(await isSweepEnabled(makeConfig("true").client)).toBe(false); // string, not boolean ⇒ off
  });

  it("isChargingEnabled reads settlement_charging_enabled; true only for explicit true", async () => {
    const on = makeConfig(true);
    expect(await isChargingEnabled(on.client)).toBe(true);
    expect(on.keys).toContain("settlement_charging_enabled");

    expect(await isChargingEnabled(makeConfig(false).client)).toBe(false);
    expect(await isChargingEnabled(makeConfig(undefined).client)).toBe(false);
  });

  it("getMinChargeCents falls back to the default when unset / non-numeric", async () => {
    expect(await getMinChargeCents(makeConfig(200).client)).toBe(200);
    expect(await getMinChargeCents(makeConfig(undefined).client)).toBe(DEFAULT_MIN_CHARGE_CENTS);
    expect(await getMinChargeCents(makeConfig("50").client)).toBe(DEFAULT_MIN_CHARGE_CENTS);
  });
});

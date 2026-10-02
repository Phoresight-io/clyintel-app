import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { requireServerEnv, optionalServerEnv, serverEnv, resolveStripeSecretKey } from "./env.server";
import { publicEnv } from "./env.public";
import { liveChargesAllowed } from "@/lib/settlement/chargeSettlement";

// Repo root = clyintel/ (two levels up from lib/config/).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── 1. Required server getters fail LOUD, naming the missing var ──────────────
describe("env.server — required getters fail loud", () => {
  it("requireServerEnv throws a clear, var-NAMED error when the var is absent", () => {
    vi.stubEnv("SOME_REQUIRED_THING", "");
    expect(() => requireServerEnv("SOME_REQUIRED_THING")).toThrow(/SOME_REQUIRED_THING/);
  });

  it("requireServerEnv returns the value when present", () => {
    vi.stubEnv("SOME_REQUIRED_THING", "hello");
    expect(requireServerEnv("SOME_REQUIRED_THING")).toBe("hello");
  });

  it("a named required getter names its own var when unset", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => serverEnv.supabaseServiceRoleKey()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc_role_123");
    expect(serverEnv.supabaseServiceRoleKey()).toBe("svc_role_123");
  });

  it("optional getters return undefined for absent/empty, never throwing", () => {
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(optionalServerEnv("STRIPE_SECRET_KEY")).toBeUndefined();
    expect(serverEnv.stripeSecretKeyOptional()).toBeUndefined();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(serverEnv.stripeSecretKeyOptional()).toBe("sk_test_x");
  });
});

// ── 2. Client-leak boundary: no Client Component imports the server env module ─
// This is the sanctioned equivalent of `import "server-only"` (that package is
// not a dependency yet). Server secrets must never be pulled into a client bundle.
describe("env.server — never imported by a Client Component", () => {
  const CLIENT_DIRECTIVE = /^\s*['"]use client['"]\s*;?/m;
  const SERVER_ENV_IMPORT = /@\/lib\/config\/env\.server/;

  function collectSourceFiles(dir: string): string[] {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        out.push(...collectSourceFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("no 'use client' file imports @/lib/config/env.server", () => {
    const files = [
      ...collectSourceFiles(path.join(REPO_ROOT, "app")),
      ...collectSourceFiles(path.join(REPO_ROOT, "components")),
      ...collectSourceFiles(path.join(REPO_ROOT, "lib")),
    ];
    // Sanity: the scan actually found source files.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return CLIENT_DIRECTIVE.test(src) && SERVER_ENV_IMPORT.test(src);
    });
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });
});

// ── 3. env.public references ONLY NEXT_PUBLIC_* vars (no secret can leak) ──────
describe("env.public — public vars only", () => {
  it("every process.env reference in env.public.ts is a NEXT_PUBLIC_ var", () => {
    const src = readFileSync(path.join(REPO_ROOT, "lib/config/env.public.ts"), "utf8");
    // Strip comments so prose examples don't count as references.
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const refs = [...code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) {
      expect(name.startsWith("NEXT_PUBLIC_")).toBe(true);
    }
  });

  it("optional public getters return undefined when unset (no throw)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(publicEnv.siteUrl()).toBeUndefined();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com");
    expect(publicEnv.siteUrl()).toBe("https://app.example.com");
  });
});

// ── 4. Regression: the money gate fails closed ────────────────────────────────
// liveChargesAllowed()'s env reads are sourced through env.server. Prove the
// default (no-arg) path reads process.env via the module and opens ONLY for
//   (a) production + sk_live (frozen), or
//   (b) sk_test + VERCEL_ENV set + QBO_ENVIRONMENT=sandbox (test mode).
// The injected-env seam is covered in chargeSettlement.test.
describe("liveChargesAllowed — re-sourced, fails closed", () => {
  // Determinism: the gate reads the key through the resolver, so neutralise any ambient _TEST var.
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "");
  });

  // ── live branch (unchanged) ──
  it("false when VERCEL_ENV is not 'production' (even with a live key)", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox"); // sandbox must not open the live branch
    expect(liveChargesAllowed()).toBe(false);
  });

  it("true for production + sk_live (proves the re-sourced reads work)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("QBO_ENVIRONMENT", "");
    expect(liveChargesAllowed()).toBe(true);
  });

  // ── test-mode branch ──
  it("true for sk_test + VERCEL_ENV set + QBO_ENVIRONMENT=sandbox", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    expect(liveChargesAllowed()).toBe(true);
  });

  it("false for sk_test + QBO_ENVIRONMENT=production (Prod misconfigured with a test key)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("QBO_ENVIRONMENT", "production");
    expect(liveChargesAllowed()).toBe(false);
  });

  it("false for sk_test + QBO_ENVIRONMENT unset", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("QBO_ENVIRONMENT", "");
    expect(liveChargesAllowed()).toBe(false);
  });

  it("false for sk_test + sandbox when VERCEL_ENV is unset (local/CI)", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    expect(liveChargesAllowed()).toBe(false);
  });

  // ── everything else is closed ──
  it.each(["rk_live_x", "rk_test_x", "pk_live_x", "whsec_x", "garbage", ""])(
    "false for unrecognised/empty key %j even in production + sandbox",
    (key) => {
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
      expect(liveChargesAllowed()).toBe(false);
    },
  );

  it("false when everything is unset", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("QBO_ENVIRONMENT", "");
    expect(liveChargesAllowed()).toBe(false);
  });
});

// ── 5. Stripe key resolver — Test/Prod separated by variable NAME ─────────────
// resolveStripeSecretKey is the ONLY reader of STRIPE_SECRET_KEY /
// STRIPE_SECRET_KEY_TEST. Pure given an injected env; the no-arg default reads
// process.env (covered via the getters and the gate below).
describe("resolveStripeSecretKey — precedence and fail-closed rules", () => {
  it("only STRIPE_SECRET_KEY set -> it, whatever the prefix (Prod and local-dev unchanged)", () => {
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY: "sk_live_x" })).toBe("sk_live_x");
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe("sk_test_x");
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_SECRET_KEY_TEST: "" })).toBe("sk_live_x");
  });

  it("only STRIPE_SECRET_KEY_TEST set with an sk_test_ key -> it", () => {
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY_TEST: "sk_test_x" })).toBe("sk_test_x");
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY: "", STRIPE_SECRET_KEY_TEST: "sk_test_x" })).toBe("sk_test_x");
  });

  it("both set (non-empty) -> undefined (misconfiguration fails closed)", () => {
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_SECRET_KEY_TEST: "sk_test_x" })).toBeUndefined();
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY: "sk_test_a", STRIPE_SECRET_KEY_TEST: "sk_test_b" })).toBeUndefined();
  });

  it.each(["sk_live_x", "rk_test_x", "sk_testx", "pk_test_x", "garbage"])(
    "STRIPE_SECRET_KEY_TEST holding %j is ignored -> undefined",
    (bad) => {
      expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY_TEST: bad })).toBeUndefined();
    },
  );

  it("both unset or empty -> undefined", () => {
    expect(resolveStripeSecretKey({})).toBeUndefined();
    expect(resolveStripeSecretKey({ STRIPE_SECRET_KEY: "", STRIPE_SECRET_KEY_TEST: "" })).toBeUndefined();
  });

  it("default (no-arg) reads process.env at call time", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_test_env");
    expect(resolveStripeSecretKey()).toBe("sk_test_env");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_env");
    expect(resolveStripeSecretKey()).toBeUndefined();
  });
});

describe("serverEnv Stripe key getters go through the resolver", () => {
  it("required getter returns the resolved key", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_test_req");
    expect(serverEnv.stripeSecretKey()).toBe("sk_test_req");
  });

  it("required getter throws naming BOTH variables when unresolved, without printing a value", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_SECRETVALUE");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_test_SECRETVALUE");
    let message = "";
    try {
      serverEnv.stripeSecretKey();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/STRIPE_SECRET_KEY\b/);
    expect(message).toMatch(/STRIPE_SECRET_KEY_TEST/);
    expect(message).not.toMatch(/SECRETVALUE/);
  });

  it("required getter throws when neither is set, and when _TEST holds a non-sk_test_ key", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "");
    expect(() => serverEnv.stripeSecretKey()).toThrow(/STRIPE_SECRET_KEY_TEST/);
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_live_x");
    expect(() => serverEnv.stripeSecretKey()).toThrow(/STRIPE_SECRET_KEY_TEST/);
  });

  it("optional getter returns the resolved key or undefined, never throwing", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_test_opt");
    expect(serverEnv.stripeSecretKeyOptional()).toBe("sk_test_opt");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(serverEnv.stripeSecretKeyOptional()).toBeUndefined();
  });
});

describe("liveChargesAllowed — default env reads the key through the resolver", () => {
  it("true: STRIPE_SECRET_KEY_TEST=sk_test_ + VERCEL_ENV set + QBO sandbox", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_test_x");
    expect(liveChargesAllowed()).toBe(true);
  });

  it("false: both variables set (even with a valid-looking combo)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_test_x");
    expect(liveChargesAllowed()).toBe(false);
  });

  it("false: sk_live in STRIPE_SECRET_KEY_TEST never opens the gate, even in production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_live_x");
    expect(liveChargesAllowed()).toBe(false);
  });

  it("true: Prod path unchanged (production + sk_live in STRIPE_SECRET_KEY only)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("QBO_ENVIRONMENT", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "");
    expect(liveChargesAllowed()).toBe(true);
  });

  it("false: STRIPE_SECRET_KEY_TEST set but QBO_ENVIRONMENT is not sandbox", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("QBO_ENVIRONMENT", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_TEST", "sk_test_x");
    expect(liveChargesAllowed()).toBe(false);
  });
});

// ── 6. Static scan: nothing but env.server.ts reads the Stripe key vars ────────
describe("Stripe key vars are read only through resolveStripeSecretKey", () => {
  const DIRECT_READ = /process\.env(?:\.|\[\s*["'])STRIPE_SECRET_KEY/;
  const SELF = path.join(REPO_ROOT, "lib/config/env-config.test.ts");
  const RESOLVER = path.join(REPO_ROOT, "lib/config/env.server.ts");

  function collectTs(dir: string): string[] {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        out.push(...collectTs(full));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("no source or test file outside env.server.ts reads process.env.STRIPE_SECRET_KEY[_TEST] directly", () => {
    const files = ["app", "components", "lib"].flatMap((d) => collectTs(path.join(REPO_ROOT, d)));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter(
      (f) => f !== RESOLVER && f !== SELF && DIRECT_READ.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("env.server.ts itself reads both variables (the scan is looking at the right names)", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/optionalServerEnv\("STRIPE_SECRET_KEY"\)/);
    expect(src).toMatch(/optionalServerEnv\("STRIPE_SECRET_KEY_TEST"\)/);
  });
});

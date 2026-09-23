import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { requireServerEnv, optionalServerEnv, serverEnv } from "./env.server";
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

// ── 4. Regression: the money gate stays FROZEN and fails closed ───────────────
// liveChargesAllowed()'s env reads were re-sourced through env.server. Prove the
// default (no-arg) path reads process.env via the module and still opens ONLY for
// production + sk_live. The injected-env seam is covered in chargeSettlement.test.
describe("liveChargesAllowed — re-sourced but frozen (fails closed)", () => {
  it("false when VERCEL_ENV is not 'production' (even with a live key)", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(liveChargesAllowed()).toBe(false);
  });

  it("false when the key is not sk_live (even in production)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(liveChargesAllowed()).toBe(false);
  });

  it("false when both are unset", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(liveChargesAllowed()).toBe(false);
  });

  it("true ONLY for production + sk_live (proves the re-sourced reads work)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    expect(liveChargesAllowed()).toBe(true);
  });
});

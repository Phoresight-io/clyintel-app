import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// Session-redirect bypass for self-authenticating machine routes. The early
// return for CRON_PATHS/WEBHOOK_PATHS happens before any Supabase client is
// built, so the exempt case needs no env. The non-exempt case does build the
// client; placeholder env is stubbed (no network: with no cookies, getUser()
// resolves to no user without calling Supabase).

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("middleware session redirect", () => {
  it("lets a no-cookie POST to /api/outreach/run through (no /login redirect)", async () => {
    const res = await middleware(
      new NextRequest("http://localhost/api/outreach/run", { method: "POST" }),
    );
    // NextResponse.next(): no Location header, not a redirect. The route's own
    // checkCronAuth then returns 401/500 without the correct Bearer secret.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("still redirects a no-cookie request to a non-exempt path (/api/voice/call) to /login", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    const res = await middleware(
      new NextRequest("http://localhost/api/voice/call", { method: "POST" }),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") as string).pathname).toBe("/login");
  });
});

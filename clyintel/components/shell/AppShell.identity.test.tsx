// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Regression tests for the account-menu identity in AppShell. These lock the
// first-paint / hydration bug that shipped tonight while 128/128 stayed green:
// useState(initialEmail) froze a null-at-first-render seed, so `email` stayed
// null even though the live `initialEmail` prop populated a render later. The
// fix renders from the live prop (displayEmail = email ?? initialEmail;
// displayInitials = initials || deriveInitials(null, initialEmail)).
//
// The component talks to Supabase (browser) + next/navigation; both are mocked
// at the module boundary (matching the repo's vi.mock pattern). Mocking every
// "@/…" import means vitest never needs the "@/" path alias.

// Mutable mock state the Supabase mock reads (vi.hoisted so the factory can see it).
const mockState = vi.hoisted(() => ({
  session: null as { user: { id: string; email: string | null } } | null,
  subscriberRow: null as Record<string, unknown> | null,
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

// Theme: any C.<token> resolves to the token name (a valid style string).
vi.mock("@/lib/theme", () => ({
  C: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock("@/lib/demo-mode", () => ({
  CLIENTS_KEY: "clyintel_clients",
  INTEGRATIONS_KEY: "clyintel_integrations",
  DEMO_RESET_KEY: "clyintel_demo_reset",
}));

vi.mock("@/lib/supabase-browser", () => ({
  createSupabaseBrowser: () => ({
    auth: {
      getSession: async () => ({ data: { session: mockState.session } }),
      signOut: mockState.signOut,
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mockState.subscriberRow }),
        }),
      }),
    }),
  }),
}));

import AppShell from "./AppShell";

const CWJR = "cwjr27@outlook.com";

/** Open the account menu (the avatar button carries aria-label="Account menu"). */
function openMenu() {
  fireEvent.click(screen.getByLabelText("Account menu"));
}

/** The avatar glyph text (initials, or the neutral/loading fallback). */
function avatarText(): string {
  return screen.getByLabelText("Account menu").textContent?.trim() ?? "";
}

let originalLocation: Location;
beforeEach(() => {
  mockState.session = null;
  mockState.subscriberRow = null;
  mockState.signOut = vi.fn(async () => ({ error: null }));
  // window.location.href is assigned on sign-out; stub it so jsdom doesn't warn/throw.
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    value: { href: "" },
    writable: true,
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe("AppShell — account-menu identity", () => {
  // Case 1: seed present, client resolves a user WITHOUT an email → the seed must
  // still show (the no-clobber guard). Fails on the pre-fix effect that did
  // setEmail(user.email ?? null).
  it("shows the seeded identity even when the client session has no email", async () => {
    mockState.session = { user: { id: "u1", email: null } };
    render(<AppShell initialEmail={CWJR}>content</AppShell>);
    openMenu();

    expect(await screen.findByText(CWJR)).toBeInTheDocument();
    await waitFor(() => expect(avatarText()).toBe("CW"));
    expect(screen.queryByText("Not signed in")).not.toBeInTheDocument();
    expect(avatarText()).not.toBe("·");
  });

  // Case 2: THE hydration race. Mount with a null seed (useState freezes null),
  // then the live prop arrives a render later. Fails on the pre-fix render that
  // read `email`/`initials` directly (stuck at the frozen null).
  it("recovers when the seed prop arrives after mount (null → populated re-render)", async () => {
    mockState.session = null; // client provides nothing
    const { rerender } = render(<AppShell initialEmail={null}>content</AppShell>);
    openMenu();
    // Before the seed arrives it is genuinely unknown → not the identity yet.
    expect(screen.queryByText(CWJR)).not.toBeInTheDocument();

    // Seed arrives on a later render (same component instance).
    rerender(<AppShell initialEmail={CWJR}>content</AppShell>);

    expect(await screen.findByText(CWJR)).toBeInTheDocument();
    await waitFor(() => expect(avatarText()).toBe("CW"));
    expect(screen.queryByText("Not signed in")).not.toBeInTheDocument();
  });

  // Case 3: client enrichment still wins over the seed (email ?? … lets a real
  // client value take over; the fix didn't freeze the display to the seed).
  it("lets client enrichment override the seed (email + name + plan)", async () => {
    mockState.session = { user: { id: "u1", email: CWJR } };
    mockState.subscriberRow = {
      business_name: "Acme Corp",
      contact_name: null,
      email: "billing@acme.com",
      plan: { display_name: "Pro" },
    };
    render(<AppShell initialEmail={CWJR}>content</AppShell>);
    openMenu();

    expect(await screen.findByText("billing@acme.com")).toBeInTheDocument();
    await waitFor(() => expect(avatarText()).toBe("AC")); // "Acme Corp" → AC
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.queryByText(CWJR)).not.toBeInTheDocument(); // overridden
  });

  // Case 4: truly logged out (no seed, client resolves no user) → the fallback
  // still renders. Confirms we didn't hardcode the identity away.
  it("shows 'Not signed in' + a neutral avatar when genuinely logged out", async () => {
    mockState.session = null;
    render(<AppShell initialEmail={null}>content</AppShell>);
    openMenu();

    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    await waitFor(() => expect(avatarText()).toBe("·")); // neutral, after resolved
    expect(avatarText()).not.toBe("JD"); // never the old hardcoded placeholder
    expect(screen.queryByText(CWJR)).not.toBeInTheDocument();
  });

  // Case 5: sign-out clears the identity immediately (signingOut state) before
  // the redirect — it must not linger on the old email.
  it("clears the identity on sign-out (does not linger on the old email)", async () => {
    mockState.session = { user: { id: "u1", email: CWJR } };
    render(<AppShell initialEmail={CWJR}>content</AppShell>);
    openMenu();
    expect(await screen.findByText(CWJR)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));

    await waitFor(() => expect(screen.queryByText(CWJR)).not.toBeInTheDocument());
    expect(screen.getByText(/signing out/i)).toBeInTheDocument();
    expect(avatarText()).not.toBe("CW");
    expect(mockState.signOut).toHaveBeenCalled();
  });

  // Case 6: initials derivation, asserted through the rendered avatar (guards the
  // CW logic and the "never JD" rule without touching production code).
  it("derives initials from the email when name metadata is absent (CW, never JD)", async () => {
    // email → initials
    mockState.session = null;
    const view = render(<AppShell initialEmail={CWJR}>content</AppShell>);
    expect(within(screen.getByLabelText("Account menu")).getByText("CW")).toBeInTheDocument();
    view.unmount();

    // no name + no email → neutral fallback, NOT "JD"
    render(<AppShell initialEmail={null}>content</AppShell>);
    await waitFor(() => expect(avatarText()).toBe("·"));
    expect(avatarText()).not.toBe("JD");
  });
});

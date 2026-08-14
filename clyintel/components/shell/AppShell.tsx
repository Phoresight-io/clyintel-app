"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { CLIENTS_KEY, INTEGRATIONS_KEY, DEMO_RESET_KEY } from "@/lib/demo-mode";

// Initials for the avatar. Derived from the real name if present, otherwise from
// the email local-part (e.g. "cwjr27@outlook.com" → "CW"). NEVER a hardcoded
// "JD"/placeholder — an empty string renders a neutral avatar instead of lying
// about who is signed in.
function deriveInitials(name: string | null, email: string | null): string {
  const source = (name || "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "";
}

export default function AppShell({
  children,
  initialEmail = null,
}: {
  children: React.ReactNode;
  /** Session email resolved server-side (root layout) so the account menu paints
   *  the real identity on first render, before the client getUser() resolves. */
  initialEmail?: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [initials, setInitials] = useState(() => deriveInitials(null, initialEmail));
  const [email, setEmail] = useState<string | null>(initialEmail);
  const [planName, setPlanName] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Identity is "resolved" once we have the SSR seed OR the client session check
  // has completed. Until then the menu shows a loading state — never a blank
  // avatar / "SIGNED IN AS —" resting state.
  const [resolved, setResolved] = useState(initialEmail != null);

  // Identity for the avatar + account menu. Sourced from the ACTUAL current
  // session user first (email is always present, never stale), then enriched
  // with the subscriber's business/contact name + plan if that row exists.
  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createSupabaseBrowser();
      // getSession() reads the session from local cookies WITHOUT a network
      // validate/refresh — so it resolves instantly on mount and never races the
      // middleware on the single-use refresh token (getUser() did, leaving the
      // menu stuck resolving). Display-only use; authorization stays server-side.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user ?? null;
      if (!active) return;
      // Session check done — flip out of the loading state whether or not a user
      // was found (a logged-out shell is a resolved "no user" state, not loading).
      setResolved(true);
      if (!user) return;

      // Session-truth — but NEVER downgrade the SSR seed. getSession() can return
      // a user whose .email is null; writing that would clobber the seed and show
      // "Not signed in" for a logged-in user. Only ever apply a REAL value.
      if (user.email) {
        setEmail(user.email);
        setInitials(deriveInitials(null, user.email));
      }

      // Enrich (nicer initials from a real name, plan label). Non-fatal if the
      // subscribers row is missing/blank — the seeded identity already stands.
      const { data } = await supabase
        .from("subscribers")
        .select("business_name, contact_name, email, plan:plans(display_name)")
        .eq("id", user.id)
        .maybeSingle();
      if (!active || !data) return;
      const planDisplay = (data.plan as { display_name?: string } | null)?.display_name ?? null;
      const enrichedEmail = data.email || user.email || null;
      if (enrichedEmail) {
        setEmail(enrichedEmail);
        setInitials(deriveInitials(data.business_name || data.contact_name, enrichedEmail));
      }
      setPlanName(planDisplay);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Sign out: end the Supabase session (server + client), clear any client-side
  // identity/demo state that could leak into the next login, then hard-navigate
  // to /login so no in-memory React state (identity, cached fetches) survives.
  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowser();
      await supabase.auth.signOut();
    } catch {
      // ignore — still clear local state and redirect below
    }
    try {
      localStorage.removeItem(CLIENTS_KEY);
      localStorage.removeItem(INTEGRATIONS_KEY);
      localStorage.removeItem(DEMO_RESET_KEY);
      sessionStorage.removeItem("clyintel_nav_direct");
    } catch {
      // localStorage may be unavailable — non-fatal
    }
    window.location.href = "/login";
  };

  // Auth and public pay routes render without shell chrome
  if (pathname === '/login' || pathname.startsWith('/auth/') || pathname.startsWith('/pay/')) {
    return <>{children}</>;
  }

  // Render identity from the LIVE prop as well as state. `email`/`initials` come
  // from useState(initialEmail), which freezes the FIRST-render value — and the
  // SSR seed can arrive null at hydration then populate a render later, leaving
  // that state stuck at null. Falling back to the current `initialEmail` prop
  // shows the identity as soon as the seed is present, regardless of useState
  // timing. On sign-out we blank it so no identity lingers before the redirect.
  const displayEmail = signingOut ? null : email ?? initialEmail;
  const displayInitials = signingOut ? "" : initials || deriveInitials(null, initialEmail);

  const isRecoveryActive = pathname === "/" || pathname.startsWith("/client") || pathname === "/connections";
  const isPortfolioActive = pathname === "/portfolio";
  const isSettingsActive = pathname.startsWith("/settings");

  const navItems = [
    { label: "Receivables", href: "/", active: isRecoveryActive, disabled: false },
    { label: "Portfolio", href: "/portfolio", active: isPortfolioActive, disabled: false },
    { label: "Settings", href: "/settings", active: isSettingsActive, disabled: false },
  ];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: C.sans }}>
      {/* Top Nav */}
      <nav style={{ height: 64, borderBottom: `1px solid ${C.border}`, background: "#FFFFFF", display: "flex", alignItems: "center", padding: "0 36px", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* Logo */}
          <img
            src="https://raw.githubusercontent.com/Phoresight-io/Brand-Kit/main/FullLogo_Transparent_NoBuffer.jpg"
            alt="Phoresight"
            onClick={() => router.push("/")}
            style={{ height: 36, objectFit: "contain", cursor: "pointer" }}
          />
          <div style={{ width: 1, height: 24, background: C.border, margin: "0 16px" }} />
          <span style={{ fontSize: 18, fontWeight: 700, color: C.navy, letterSpacing: "-0.5px" }}>Clyintel</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Nav Items */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {navItems.map(item => (
              <button
                key={item.label}
                onClick={() => { if (!item.disabled) { sessionStorage.setItem('clyintel_nav_direct', 'true'); router.push(item.href); } }}
                style={{
                  padding: "6px 14px",
                  fontSize: 15,
                  fontWeight: item.active ? 600 : 500,
                  color: item.disabled ? C.textDim : item.active ? C.navy : C.textMid,
                  background: item.active ? C.blueBg : "transparent",
                  border: "none",
                  borderRadius: 6,
                  cursor: item.disabled ? "not-allowed" : "pointer",
                  opacity: item.disabled ? 0.5 : 1,
                  transition: "background 0.15s, color 0.15s",
                }}
                onMouseEnter={(e) => { if (!item.disabled && !item.active) e.currentTarget.style.background = C.surface; }}
                onMouseLeave={(e) => { if (!item.disabled && !item.active) e.currentTarget.style.background = "transparent"; }}
              >
                {item.label}
              </button>
            ))}
          </div>
          {/* Account menu (avatar → dropdown with the signed-in email + sign out) */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={displayEmail ?? undefined}
              style={{ width: 32, height: 32, borderRadius: "50%", background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", border: "none", cursor: "pointer", padding: 0 }}
            >
              <span style={{ fontSize: 13, fontWeight: 700, color: "#FFFFFF", opacity: displayInitials ? 1 : 0.6 }}>{displayInitials || (resolved ? "·" : "…")}</span>
            </button>
            {menuOpen && (
              <>
                {/* click-away backdrop */}
                <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
                <div role="menu" style={{ position: "absolute", top: 40, right: 0, minWidth: 220, background: "#FFFFFF", border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 201, overflow: "hidden" }}>
                  <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Signed in as</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: displayEmail ? C.navy : C.textDim, wordBreak: "break-all" }}>
                      {displayEmail ? displayEmail : resolved ? "Not signed in" : "Loading…"}
                    </div>
                    {planName && <div style={{ fontSize: 12, color: C.textMid, marginTop: 3 }}>{planName}</div>}
                  </div>
                  <button
                    role="menuitem"
                    onClick={handleSignOut}
                    disabled={signingOut}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "11px 14px", fontSize: 14, fontWeight: 600, color: C.red, background: "transparent", border: "none", cursor: signingOut ? "default" : "pointer" }}
                    onMouseEnter={(e) => { if (!signingOut) e.currentTarget.style.background = C.surface; }}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main style={{ flex: 1, background: C.bg }}>
        {children}
      </main>

      {/* Footer */}
      <footer style={{ height: 44, borderTop: `1px solid ${C.border}`, background: C.surface, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 36px" }}>
        <span style={{ fontSize: 13, color: C.textDim, fontWeight: 500, fontFamily: C.mono }}>Clyintel · Payment Intelligence{planName ? ` · ${planName}` : ""}</span>
        <span style={{ fontSize: 13, color: C.textDim, fontWeight: 500, fontFamily: C.mono }}>Updated {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
      </footer>
    </div>
  );
}

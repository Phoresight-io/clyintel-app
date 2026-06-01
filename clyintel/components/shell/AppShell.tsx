"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { C } from "@/lib/theme";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

function deriveInitials(name: string | null, email: string | null): string {
  const source = (name || "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "JD";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [initials, setInitials] = useState("JD");
  const [planName, setPlanName] = useState<string | null>(null);

  // Fetch the current subscriber (and their plan) for the avatar + footer.
  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("subscribers")
        .select("business_name, contact_name, email, plan:plans(display_name)")
        .eq("id", user.id)
        .maybeSingle();
      if (!active || !data) return;
      const planDisplay = (data.plan as { display_name?: string } | null)?.display_name ?? null;
      setInitials(deriveInitials(data.business_name || data.contact_name, data.email || user.email || null));
      setPlanName(planDisplay);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Auth routes render without shell chrome
  if (pathname === '/login' || pathname.startsWith('/auth/')) {
    return <>{children}</>;
  }

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
          {/* Avatar */}
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.navy, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#FFFFFF" }}>{initials}</span>
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

"use client";
import { usePathname, useRouter } from "next/navigation";
import { C } from "@/lib/theme";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const isRecoveryActive = pathname === "/" || pathname.startsWith("/client") || pathname === "/connections";
  const isPortfolioActive = pathname === "/portfolio";
  const isSettingsActive = pathname.startsWith("/settings");

  const navItems = [
    { label: "Recovery", href: "/", active: isRecoveryActive, disabled: false },
    { label: "Portfolio", href: "/portfolio", active: isPortfolioActive, disabled: false },
    { label: "Settings", href: "/settings", active: isSettingsActive, disabled: false },
  ];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: C.sans }}>
      {/* Top Nav */}
      <nav style={{ height: 64, borderBottom: `1px solid ${C.border}`, background: "#FFFFFF", display: "flex", alignItems: "center", padding: "0 36px", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Logo */}
          <img
            src="https://raw.githubusercontent.com/Phoresight-io/Brand-Kit/main/FullLogo_Transparent_NoBuffer.jpg"
            alt="Phoresight"
            onClick={() => router.push("/")}
            style={{ height: 36, objectFit: "contain", cursor: "pointer", marginRight: 16 }}
          />
          {/* Nav Items */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {navItems.map(item => (
              <button
                key={item.label}
                onClick={() => !item.disabled && router.push(item.href)}
                style={{
                  padding: "6px 14px",
                  fontSize: 14,
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
        </div>
        {/* Avatar */}
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.navy, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#FFFFFF" }}>JD</span>
        </div>
      </nav>

      {/* Main Content */}
      <main style={{ flex: 1, background: C.bg }}>
        {children}
      </main>

      {/* Footer */}
      <footer style={{ height: 44, borderTop: `1px solid ${C.border}`, background: C.surface, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 36px" }}>
        <span style={{ fontSize: 12, color: C.textDim, fontFamily: C.mono }}>Clyintel · Payment Intelligence</span>
        <span style={{ fontSize: 12, color: C.textDim, fontFamily: C.mono }}>Updated {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
      </footer>
    </div>
  );
}

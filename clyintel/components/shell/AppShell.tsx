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
          {/* LinkedIn */}
          <a
            href="https://www.linkedin.com/company/phoresight/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "#0A66C2", lineHeight: 0 }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#0A66C2" xmlns="http://www.w3.org/2000/svg">
              <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
            </svg>
          </a>
          {/* Avatar */}
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.navy, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#FFFFFF" }}>JD</span>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main style={{ flex: 1, background: C.bg }}>
        {children}
      </main>

      {/* Footer */}
      <footer style={{ height: 44, borderTop: `1px solid ${C.border}`, background: C.surface, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 36px" }}>
        <span style={{ fontSize: 13, color: C.textDim, fontWeight: 500, fontFamily: C.mono }}>Clyintel · Payment Intelligence</span>
        <span style={{ fontSize: 13, color: C.textDim, fontWeight: 500, fontFamily: C.mono }}>Updated {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
      </footer>
    </div>
  );
}

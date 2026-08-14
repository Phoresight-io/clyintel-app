import type { Metadata } from "next";
import { headers } from "next/headers";
import { Inter, JetBrains_Mono } from "next/font/google";
import AppShell from "@/components/shell/AppShell";
import { createSupabaseServer } from "@/lib/supabase-server";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Clyintel — Payment Intelligence",
  description: "AI-powered accounts receivable and collections intelligence",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Seed the account menu with the identity the middleware already resolved
  // (forwarded via the x-user-email header) so it paints on first render with no
  // blank-avatar / "SIGNED IN AS —" flash. Reading the header — rather than
  // running a SECOND server-side getUser() here — avoids racing the middleware on
  // the single-use refresh token (that race is what left the seed null). Fall
  // back to getUser() only if the header is somehow absent.
  const h = await headers();
  let initialEmail = h.get("x-user-email");
  if (!initialEmail) {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    initialEmail = user?.email ?? null;
  }

  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body style={{ margin: 0, padding: 0, background: "#FFFFFF" }}>
        <AppShell initialEmail={initialEmail}>{children}</AppShell>
      </body>
    </html>
  );
}

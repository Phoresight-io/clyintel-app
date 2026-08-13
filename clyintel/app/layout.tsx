import type { Metadata } from "next";
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
  // Resolve the session server-side so the account menu paints the real identity
  // on first render (no blank-avatar / "SIGNED IN AS —" flash before the client
  // getUser() resolves). AppShell still refreshes/enriches this client-side.
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body style={{ margin: 0, padding: 0, background: "#FFFFFF" }}>
        <AppShell initialEmail={user?.email ?? null}>{children}</AppShell>
      </body>
    </html>
  );
}

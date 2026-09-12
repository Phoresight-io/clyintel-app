"use client";
import type { ReactNode } from "react";
import { C } from "@/lib/theme";

// Shared presentational primitives + formatters for the three history logs
// (transactions, communications, calls). Styled only with the C theme tokens to
// match the Contacts / Invoice History cards on the detail screen — this repo has
// no Tailwind.

export type Tone = "green" | "amber" | "red" | "gray" | "blue";

// Tone → foreground / background / border colors, mapped onto the C tokens.
export function toneColors(tone: Tone): { fg: string; bg: string; border: string } {
  switch (tone) {
    case "green":
      return { fg: C.green, bg: C.greenBg, border: C.green };
    case "amber":
      return { fg: C.amber, bg: C.amberBg, border: C.amber };
    case "red":
      return { fg: C.red, bg: C.redBg, border: C.red };
    case "blue":
      return { fg: C.blue, bg: C.blueBg, border: C.blue };
    case "gray":
    default:
      return { fg: C.textMid, bg: C.surface, border: C.border };
  }
}

// A bordered card mirroring the Contacts card: C.surface header with an uppercase
// navy title + a count on the right, then either an empty-state row or children.
export function LogCard({
  title,
  count,
  emptyLabel,
  children,
}: {
  title: string;
  count: number;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
      <div
        style={{
          padding: "10px 16px",
          background: C.surface,
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {title}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.textMid, fontFamily: C.mono }}>{count}</span>
      </div>
      {count === 0 ? (
        <div style={{ padding: "20px 16px", fontSize: 14, color: C.textDim, fontWeight: 500 }}>{emptyLabel}</div>
      ) : (
        children
      )}
    </div>
  );
}

// One row inside a LogCard. Top border on every row except the first.
export function LogRow({ first, children }: { first?: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        padding: "14px 16px",
        borderTop: first ? "none" : `1px solid ${C.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

// A small pill badge in a given tone.
export function Badge({ label, tone = "gray" }: { label: string; tone?: Tone }) {
  const c = toneColors(tone);
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// A labelled inline value ("Label: value").
export function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>
      <span style={{ color: C.text, fontWeight: 600 }}>{label}:</span> {value}
    </div>
  );
}

// ── Formatters ───────────────────────────────────────────────────────────────

// e.g. "May 18, 2026, 2:04 PM"
export function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// e.g. "May 18, 2026"
export function fmtDay(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Seconds → "m:ss".
export function fmtDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

// A USD dollar amount (cost_usd) → "$0.42".
export function fmtCost(usd: number | null): string {
  if (usd === null || usd === undefined || isNaN(usd)) return "—";
  return `$${usd.toFixed(2)}`;
}

// A dollar amount (committed_amount) → "$1,250.00".
export function fmtMoney(amount: number | null): string {
  if (amount === null || amount === undefined || isNaN(amount)) return "—";
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Cents → a currency string, e.g. 125000 → "$1,250.00".
export function fmtCents(cents: number | null, currency?: string | null): string {
  if (cents === null || cents === undefined || isNaN(cents)) return "—";
  const dollars = cents / 100;
  const cur = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(dollars);
  } catch {
    return `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

// snake_case / kebab-case → "Title Case".
export function prettify(value: string | null): string {
  if (!value) return "—";
  const words = value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return "—";
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

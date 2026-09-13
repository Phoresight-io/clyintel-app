"use client";
import { C } from "@/lib/theme";
import type { TransactionDisplay, BalanceEventDisplay } from "@/lib/data";
import { LogCard, LogRow, Badge, type Tone, fmtDay, fmtCents, prettify } from "./logUi";

// payment status → tone: succeeded green, pending amber, failed red, refunded gray.
function statusTone(status: string | null): Tone {
  switch (status) {
    case "succeeded":
      return "green";
    case "pending":
      return "amber";
    case "failed":
      return "red";
    case "refunded":
      return "gray";
    default:
      return "gray";
  }
}

// One normalized transaction row, merged from Stripe allocations and off-Stripe
// (e.g. QBO) balance-decrease events.
interface Row {
  key: string;
  source: "Stripe" | "QBO";
  amount_cents: number;
  currency: string | null;
  sortTs: number;
  date: string | null;
  badge: { label: string; tone: Tone };
  method: string | null;
  refunded_amount_cents: number | null;
}

function ts(value: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return isNaN(t) ? 0 : t;
}

function TransactionRow({ row, first }: { row: Row; first?: boolean }) {
  const refunded = (row.refunded_amount_cents ?? 0) > 0;
  return (
    <LogRow first={first}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: C.mono }}>
          {fmtCents(Math.abs(row.amount_cents), row.currency)}
        </span>
        <Badge label={row.badge.label} tone={row.badge.tone} />
        <span style={{ fontSize: 12, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{row.source}</span>
        <span style={{ marginLeft: "auto", fontSize: 13, color: C.textMid }}>{fmtDay(row.date)}</span>
      </div>
      {(row.method || refunded) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {row.method && <span style={{ fontSize: 13, color: C.textMid }}>{prettify(row.method)}</span>}
          {refunded && (
            <span style={{ fontSize: 12, color: C.textMid, fontStyle: "italic" }}>
              Refunded {fmtCents(row.refunded_amount_cents, row.currency)}
            </span>
          )}
        </div>
      )}
    </LogRow>
  );
}

export default function TransactionLog({
  transactions = [],
  balanceEvents = [],
}: {
  transactions?: TransactionDisplay[];
  balanceEvents?: BalanceEventDisplay[];
}) {
  const stripeRows: Row[] = transactions.map((t) => ({
    key: `stripe:${t.id}`,
    source: "Stripe",
    amount_cents: t.amount_cents,
    currency: t.currency,
    sortTs: ts(t.paid_at ?? t.allocated_at),
    date: t.paid_at ?? t.allocated_at,
    badge: { label: t.status ? prettify(t.status) : "Unknown", tone: statusTone(t.status) },
    method: t.payment_method,
    refunded_amount_cents: t.refunded_amount_cents,
  }));

  const qboRows: Row[] = balanceEvents.map((b) => ({
    key: `qbo:${b.id}`,
    source: "QBO",
    amount_cents: b.delta_cents,
    currency: "USD",
    sortTs: ts(b.detected_at),
    date: b.detected_at,
    badge: { label: "Payment", tone: "green" },
    method: null,
    refunded_amount_cents: null,
  }));

  const rows = [...stripeRows, ...qboRows].sort((a, b) => b.sortTs - a.sortTs);

  return (
    <LogCard title="Transactions" count={rows.length} emptyLabel="No transactions yet.">
      {rows.map((r, i) => (
        <TransactionRow key={r.key} row={r} first={i === 0} />
      ))}
    </LogCard>
  );
}

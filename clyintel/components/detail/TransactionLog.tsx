"use client";
import { C } from "@/lib/theme";
import type { TransactionDisplay } from "@/lib/data";
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

function TransactionRow({ tx, first, showInvoice }: { tx: TransactionDisplay; first?: boolean; showInvoice?: boolean }) {
  const date = tx.paid_at ?? tx.allocated_at;
  const refunded = (tx.refunded_amount_cents ?? 0) > 0;

  return (
    <LogRow first={first}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: C.mono }}>
          {fmtCents(tx.amount_cents, tx.currency)}
        </span>
        <Badge label={tx.status ? prettify(tx.status) : "Unknown"} tone={statusTone(tx.status)} />
        {showInvoice && tx.invoice_number && (
          <span style={{ fontSize: 12, color: C.textMid, fontFamily: C.mono }}>Invoice {tx.invoice_number}</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 13, color: C.textMid }}>{fmtDay(date)}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {tx.payment_method && (
          <span style={{ fontSize: 13, color: C.textMid }}>{prettify(tx.payment_method)}</span>
        )}
        {refunded && (
          <span style={{ fontSize: 12, color: C.textMid, fontStyle: "italic" }}>
            Refunded {fmtCents(tx.refunded_amount_cents, tx.currency)}
          </span>
        )}
      </div>
    </LogRow>
  );
}

export default function TransactionLog({
  transactions,
  showInvoice,
}: {
  transactions: TransactionDisplay[];
  showInvoice?: boolean;
}) {
  return (
    <LogCard title="Transactions" count={transactions.length} emptyLabel="No transactions yet.">
      {transactions.map((tx, i) => (
        <TransactionRow key={tx.id} tx={tx} first={i === 0} showInvoice={showInvoice} />
      ))}
    </LogCard>
  );
}

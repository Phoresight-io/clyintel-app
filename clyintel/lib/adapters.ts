import type { Database } from "@/types/supabase";
import type { Client, Invoice, ClientInvoiceSet, ClientStatus } from "@/lib/mock-data";

// Maps real Supabase rows onto the UI shapes the screen components already
// consume (`Client`, `Invoice`, `ClientInvoiceSet`). Keeps the components
// presentation-only and avoids a wholesale rewrite of the demo-mode UI.

type ClientRow = Database["public"]["Tables"]["clients"]["Row"];
type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];
type PtrScoreRow = Database["public"]["Tables"]["ptr_scores"]["Row"];

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

function daysFromToday(due: string | null): number | null {
  if (!due) return null;
  const d = new Date(due);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  return Math.round((d.getTime() - today.getTime()) / MS_PER_DAY);
}

function uiStatus(status: InvoiceRow["status"]): "past_due" | "current" | "paid" {
  if (status === "paid") return "paid";
  if (status === "overdue" || status === "in_recovery" || status === "written_off") return "past_due";
  return "current";
}

export function toUIInvoice(row: InvoiceRow): Invoice {
  const ui = uiStatus(row.status);
  const dayDelta = daysFromToday(row.due_date);
  const invoice: Invoice = {
    id: row.invoice_number || row.id,
    amount: Math.round(row.amount_cents) / 100,
    dueDate: formatDate(row.due_date),
    status: ui,
    lastActivity: row.last_reminder_at ? formatDate(row.last_reminder_at) : "—",
  };
  if (ui === "past_due") {
    invoice.daysOverdue = dayDelta !== null && dayDelta < 0 ? Math.abs(dayDelta) : 0;
  } else if (ui === "current") {
    invoice.daysUntilDue = dayDelta ?? undefined;
  } else if (ui === "paid") {
    invoice.paidDate = formatDate(row.updated_at);
  }
  return invoice;
}

export function toUIClientInvoiceSet(rows: InvoiceRow[]): ClientInvoiceSet {
  const set: ClientInvoiceSet = { outstanding: [], upcoming: [], paid: [] };
  for (const row of rows) {
    const inv = toUIInvoice(row);
    if (inv.status === "paid") set.paid.push(inv);
    else if (inv.status === "past_due") set.outstanding.push(inv);
    else set.upcoming.push(inv);
  }
  return set;
}

function deriveStatus(rows: InvoiceRow[]): ClientStatus {
  const statuses = rows.map((r) => uiStatus(r.status));
  if (statuses.some((s) => s === "past_due")) return "past_due";
  const hasOpen = statuses.some((s) => s === "current");
  if (hasOpen) {
    // "due" if anything is due within 7 days, else "current"
    const dueSoon = rows.some((r) => {
      if (uiStatus(r.status) !== "current") return false;
      const delta = daysFromToday(r.due_date);
      return delta !== null && delta <= 7;
    });
    return dueSoon ? "due" : "current";
  }
  return rows.length > 0 ? "recovered" : "current";
}

export function toUIClient(client: ClientRow, ptr: PtrScoreRow | null, invoices: InvoiceRow[]): Client {
  const outstandingCents = invoices.reduce(
    (sum, inv) => (uiStatus(inv.status) === "past_due" ? sum + (inv.amount_outstanding_cents ?? inv.amount_cents) : sum),
    0
  );
  const maxOverdue = invoices.reduce((max, inv) => {
    if (uiStatus(inv.status) !== "past_due") return max;
    const delta = daysFromToday(inv.due_date);
    const overdue = delta !== null && delta < 0 ? Math.abs(delta) : 0;
    return Math.max(max, overdue);
  }, 0);

  const score = ptr?.composite_score ?? 0;
  return {
    id: client.id,
    name: client.name,
    industry: client.company || "—",
    score,
    prevScore: score,
    status: deriveStatus(invoices),
    balance: Math.round(outstandingCents) / 100,
    daysOverdue: maxOverdue,
    invoices: invoices.length,
    lastActivity: formatDate(client.updated_at),
    nextAction: "",
    scoreSummary: ptr?.ai_recommendation ? [ptr.ai_recommendation] : [],
    scoreFactors: [],
    riskDrivers: ptr?.risk_level ? [`Risk level: ${ptr.risk_level}`] : [],
  };
}

import { getSupabase } from "@/lib/supabase";
import type { Database } from "@/types/supabase";
import { toUIClient, toUIClientInvoiceSet } from "@/lib/adapters";
import type { Client as UIClientShape, ClientInvoiceSet } from "@/lib/mock-data";
import type { ClientContactDisplay } from "@/lib/contacts/contactDisplay";

// All data-fetching functions live here.
//
// Server-side reads use the service-role client (`getSupabase()`), but EVERY
// query is explicitly scoped to the caller's `userId` (= `auth.uid()`), per
// CONSTITUTION rule 9 — never fetch without user context. The `userId` is
// obtained in the calling Server Component from the cookie-bound auth client
// (`createSupabaseServer().auth.getUser()`).

type SubscriberRow = Database["public"]["Tables"]["subscribers"]["Row"];
type PlanRow = Database["public"]["Tables"]["plans"]["Row"];
type ClientRow = Database["public"]["Tables"]["clients"]["Row"];
type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];
type CommunicationRow = Database["public"]["Tables"]["communications"]["Row"];
type PtrScoreRow = Database["public"]["Tables"]["ptr_scores"]["Row"];
type RecoveryAttemptRow = Database["public"]["Tables"]["recovery_attempts"]["Row"];

export type SubscriberWithPlan = SubscriberRow & { plan: PlanRow | null };
export type InvoiceWithClient = InvoiceRow & { client: Pick<ClientRow, "id" | "name" | "company"> | null };

type CommunicationChannel = Database["public"]["Enums"]["communication_channel"];
type CommunicationDirection = Database["public"]["Enums"]["communication_direction"];
type PaymentStatus = Database["public"]["Enums"]["payment_status"];

// Email/SMS/voice communications for a client. Every row carries invoice_id (the
// real invoices.id UUID); callers match to the open invoice on that, so no
// invoice_number embed is needed.
export interface CommunicationDisplay {
  id: string;
  invoice_id: string | null;
  channel: CommunicationChannel;
  direction: CommunicationDirection;
  subject: string | null;
  body: string | null;
  status: string;
  from_address: string | null;
  to_address: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
  reply_body: string | null;
  reply_received_at: string | null;
  ai_intent: string | null;
}

// A settled allocation of a payment to an invoice (successful captures + refunds
// only). `amount_cents` is the ALLOCATED amount from invoice_payments;
// `payment_amount_cents` is the parent payment's own total. Matched by invoice_id.
export interface TransactionDisplay {
  id: string;
  invoice_id: string;
  amount_cents: number;
  allocated_at: string;
  status: PaymentStatus | null;
  payment_method: string | null;
  paid_at: string | null;
  currency: string | null;
  refunded_amount_cents: number | null;
  payment_amount_cents: number | null;
}

// A balance-decrease event on an invoice (an off-Stripe payment, e.g. detected
// from QBO). `delta_cents` is new_outstanding - prev_outstanding (negative for a
// payment); callers display its magnitude. Matched by invoice_id.
export interface BalanceEventDisplay {
  id: string;
  invoice_id: string;
  source: string;
  delta_cents: number;
  prev_outstanding_cents: number;
  new_outstanding_cents: number;
  detected_at: string;
}

// Subscriber row + joined plan.
export async function getSubscriber(userId: string): Promise<SubscriberWithPlan | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("subscribers")
    .select("*, plan:plans(*)")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("getSubscriber error", error);
    return null;
  }
  return (data as unknown as SubscriberWithPlan) ?? null;
}

// All clients for a subscriber.
export async function getClients(userId: string): Promise<ClientRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("subscriber_id", userId)
    .order("name", { ascending: true });
  if (error) {
    console.error("getClients error", error);
    return [];
  }
  return data ?? [];
}

// A single client by id, scoped to the subscriber (RLS-equivalent filter).
export async function getClient(userId: string, clientId: string): Promise<ClientRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("subscriber_id", userId)
    .eq("id", clientId)
    .maybeSingle();
  if (error) {
    console.error("getClient error", error);
    return null;
  }
  return data ?? null;
}

// All invoices for a subscriber, with the client name joined.
export async function getInvoices(userId: string): Promise<InvoiceWithClient[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("invoices")
    .select("*, client:clients(id, name, company)")
    .eq("subscriber_id", userId)
    .order("due_date", { ascending: true });
  if (error) {
    console.error("getInvoices error", error);
    return [];
  }
  return (data as unknown as InvoiceWithClient[]) ?? [];
}

// Invoices for a single client (scoped to the subscriber).
export async function getInvoicesByClient(userId: string, clientId: string): Promise<InvoiceRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("subscriber_id", userId)
    .eq("client_id", clientId)
    .order("due_date", { ascending: false });
  if (error) {
    console.error("getInvoicesByClient error", error);
    return [];
  }
  return data ?? [];
}

// Exchange (communication) history for a single invoice (scoped to subscriber).
export async function getCommunications(userId: string, invoiceId: string): Promise<CommunicationRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("communications")
    .select("*")
    .eq("subscriber_id", userId)
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("getCommunications error", error);
    return [];
  }
  return data ?? [];
}

// Latest PTR score for a client (scoped to subscriber).
export async function getPtrScores(userId: string, clientId: string): Promise<PtrScoreRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ptr_scores")
    .select("*")
    .eq("subscriber_id", userId)
    .eq("client_id", clientId)
    .order("score_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("getPtrScores error", error);
    return null;
  }
  return data ?? null;
}

// Contacts for a single client (read-only display — Brick 3). client_contacts has
// no subscriber_id, so the query is user-scoped via the parent client join:
// `clients!inner(subscriber_id)` + `.eq("clients.subscriber_id", userId)` means a
// contact only returns when its client belongs to userId — the query itself
// enforces ownership (per this file's "every query scoped to userId" rule), not
// just the caller's prior getClient. Fail-closed → [].
export async function getClientContacts(
  userId: string,
  clientId: string,
): Promise<ClientContactDisplay[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("client_contacts")
    .select(
      "id, client_id, name, role, contact_type, is_primary, email, phone, email_rank, sms_rank, voice_rank, opt_out_email, opt_out_sms, opt_out_voice, clients!inner(subscriber_id)",
    )
    .eq("client_id", clientId)
    .eq("clients.subscriber_id", userId)
    .order("is_primary", { ascending: false });
  if (error) {
    console.error("getClientContacts error", error);
    return []; // fail closed → no contacts shown
  }
  // Strip the join-only `clients` embed; return the plain display shape.
  return (data ?? []).map((r) => ({
    id: r.id,
    client_id: r.client_id,
    name: r.name,
    role: r.role,
    contact_type: r.contact_type,
    is_primary: r.is_primary,
    email: r.email,
    phone: r.phone,
    email_rank: r.email_rank,
    sms_rank: r.sms_rank,
    voice_rank: r.voice_rank,
    opt_out_email: r.opt_out_email,
    opt_out_sms: r.opt_out_sms,
    opt_out_voice: r.opt_out_voice,
  }));
}

export interface UIPortfolio {
  clients: UIClientShape[];
  clientInvoices: Record<string, ClientInvoiceSet>;
}

// Aggregates a subscriber's clients + invoices + latest PTR scores into the UI
// shapes the dashboard and portfolio screens consume. Returns empty structures
// for a subscriber with no data yet.
export async function getUIPortfolio(userId: string): Promise<UIPortfolio> {
  const [clients, invoices] = await Promise.all([getClients(userId), getInvoices(userId)]);

  const byClient = new Map<string, InvoiceRow[]>();
  for (const inv of invoices) {
    const arr = byClient.get(inv.client_id) ?? [];
    arr.push(inv);
    byClient.set(inv.client_id, arr);
  }

  const uiClients: UIClientShape[] = [];
  const clientInvoices: Record<string, ClientInvoiceSet> = {};
  for (const client of clients) {
    const clientInv = byClient.get(client.id) ?? [];
    const ptr = await getPtrScores(userId, client.id);
    uiClients.push(toUIClient(client, ptr, clientInv));
    clientInvoices[client.id] = toUIClientInvoiceSet(clientInv);
  }

  return { clients: uiClients, clientInvoices };
}

// All communications for a client (scoped to subscriber), newest first. Every
// row carries invoice_id; callers match to the open invoice on that UUID, so no
// invoice_number embed. Fail closed → [].
export async function getCommunicationsByClient(
  userId: string,
  clientId: string,
): Promise<CommunicationDisplay[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("communications")
    .select(
      "id, invoice_id, channel, direction, subject, body, status, from_address, to_address, sent_at, delivered_at, created_at, reply_body, reply_received_at, ai_intent",
    )
    .eq("subscriber_id", userId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("getCommunicationsByClient error", error);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    invoice_id: r.invoice_id,
    channel: r.channel,
    direction: r.direction,
    subject: r.subject,
    body: r.body,
    status: r.status,
    from_address: r.from_address,
    to_address: r.to_address,
    sent_at: r.sent_at,
    delivered_at: r.delivered_at,
    created_at: r.created_at,
    reply_body: r.reply_body,
    reply_received_at: r.reply_received_at,
    ai_intent: r.ai_intent,
  }));
}

// Payment→invoice allocations for a client's invoices, newest first. payments has
// NO invoice_id, so we read the invoice_payments allocation join and pull the
// payment fields through the `payment:payments(...)` embed. Ownership is enforced
// via the `invoices!inner(client_id, subscriber_id)` embed filtered on both —
// invoice_payments itself carries no subscriber_id/client_id. Fail closed → [].
export async function getInvoicePaymentsByClient(
  userId: string,
  clientId: string,
): Promise<TransactionDisplay[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("invoice_payments")
    .select(
      "id, invoice_id, amount_cents, allocated_at, payment:payments(status, payment_method, paid_at, currency, refunded_amount_cents, amount_cents), invoice:invoices!inner(client_id, subscriber_id)",
    )
    .eq("invoice.client_id", clientId)
    .eq("invoice.subscriber_id", userId)
    .order("allocated_at", { ascending: false });
  if (error) {
    console.error("getInvoicePaymentsByClient error", error);
    return [];
  }
  return (data ?? []).map((r) => {
    const payment = Array.isArray(r.payment) ? r.payment[0] : r.payment;
    return {
      id: r.id,
      invoice_id: r.invoice_id,
      amount_cents: r.amount_cents,
      allocated_at: r.allocated_at,
      status: payment?.status ?? null,
      payment_method: payment?.payment_method ?? null,
      paid_at: payment?.paid_at ?? null,
      currency: payment?.currency ?? null,
      refunded_amount_cents: payment?.refunded_amount_cents ?? null,
      payment_amount_cents: payment?.amount_cents ?? null,
    };
  });
}

// Off-Stripe payments (e.g. QBO), detected as invoice balance decreases, for a
// given set of invoice UUIDs (the client's invoices, from getInvoicesByClient).
// balance_events has no client_id, so scope by subscriber_id + invoice_id IN the
// caller's invoice UUIDs — no embed. Only rows where the outstanding balance
// dropped (new < prev) count as a payment. Newest first; fail closed → [].
export async function getBalanceEventsByClient(
  userId: string,
  invoiceUuids: string[],
): Promise<BalanceEventDisplay[]> {
  if (invoiceUuids.length === 0) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("balance_events")
    .select("id, invoice_id, source, prev_outstanding_cents, new_outstanding_cents, delta_cents, detected_at")
    .eq("subscriber_id", userId)
    .in("invoice_id", invoiceUuids)
    .order("detected_at", { ascending: false });
  if (error) {
    console.error("getBalanceEventsByClient error", error);
    return [];
  }
  return (data ?? [])
    .filter((r) => r.new_outstanding_cents < r.prev_outstanding_cents)
    .map((r) => ({
      id: r.id,
      invoice_id: r.invoice_id,
      source: r.source,
      delta_cents: r.delta_cents,
      prev_outstanding_cents: r.prev_outstanding_cents,
      new_outstanding_cents: r.new_outstanding_cents,
      detected_at: r.detected_at,
    }));
}

// Recovery history for a single invoice (scoped to subscriber).
export async function getRecoveryAttempts(userId: string, invoiceId: string): Promise<RecoveryAttemptRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("recovery_attempts")
    .select("*")
    .eq("subscriber_id", userId)
    .eq("invoice_id", invoiceId)
    .order("attempt_number", { ascending: true });
  if (error) {
    console.error("getRecoveryAttempts error", error);
    return [];
  }
  return data ?? [];
}

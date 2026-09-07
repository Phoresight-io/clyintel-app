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
      "id, contact_type, email, phone, email_rank, sms_rank, voice_rank, opt_out_email, opt_out_sms, opt_out_voice, clients!inner(subscriber_id)",
    )
    .eq("client_id", clientId)
    .eq("clients.subscriber_id", userId);
  if (error) {
    console.error("getClientContacts error", error);
    return []; // fail closed → no contacts shown
  }
  // Strip the join-only `clients` embed; return the plain display shape.
  return (data ?? []).map((r) => ({
    id: r.id,
    contact_type: r.contact_type,
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

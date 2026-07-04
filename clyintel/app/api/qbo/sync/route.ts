import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { getSupabase } from "@/lib/supabase";
import { getValidAccessToken } from "@/lib/qbo/tokens";
import { listCustomers, listInvoices } from "@/lib/qbo/client";
import { mergeClientContact } from "@/lib/qbo/mergeClientContact";
import { evaluateOutreachEligibility } from "@/lib/outreach/eligibility";

// QuickBooks Online full intake sync. On POST, for the authenticated subscriber:
// pull every Customer + Invoice from QBO and upsert them into clients / invoices.
//
// Auth: cookie-bound (createSupabaseServer → auth.getUser); user.id IS the
// subscriber id. Reads/writes use the service-role client (getSupabase) so the
// bulk upsert isn't gated by per-row RLS — every row is stamped subscriber_id =
// user.id, so the write stays scoped to the caller.
//
// Idempotent: upserts key on (subscriber_id, source, external_id) with
// source = 'qbo', so re-running updates in place and never duplicates.
//
// Transport/persistence only: NO past-due logic (that's the adapter's job), no
// dollar formatting beyond dollars→cents, no cron, no UI. Node runtime
// (service-role key + token decryption); never cached.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  // Auth first — never touch QBO or the DB without an authenticated subscriber.
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const subscriberId = user.id;

  try {
    // Valid access token (refreshed if needed) + the realm to query.
    const { accessToken, realmId } = await getValidAccessToken(subscriberId);

    // Full lists from QBO. Customers first so their ids exist before invoices,
    // which FK to clients.id.
    const customers = await listCustomers(realmId, accessToken);
    const invoices = await listInvoices(realmId, accessToken);

    const service = getSupabase();

    // --- Customers → clients ---------------------------------------------
    // name is NOT NULL: fall back to the QBO Id when DisplayName is absent so
    // we never attempt a null insert.
    let customersUpserted = 0;
    const clientIdByQboId = new Map<string, string>(); // QBO Customer Id → clients.id

    if (customers.length > 0) {
      // Pre-read existing contact values so a re-sync where QBO omits email/phone
      // coalesces against what we already have (never clobber a non-null with
      // null — supabase-js .upsert writes every payload column). Keyed by the QBO
      // Customer Id (= clients.external_id for source='qbo').
      const existingContactByQboId = new Map<string, { email: string | null; phone: string | null }>();
      const { data: existingClients, error: existingError } = await service
        .from("clients")
        .select("external_id, email, phone")
        .eq("subscriber_id", subscriberId)
        .eq("source", "qbo");

      if (existingError) {
        throw new Error(`QBO sync: existing clients read failed: ${existingError.message}`);
      }
      for (const row of existingClients ?? []) {
        if (row.external_id) {
          existingContactByQboId.set(row.external_id, { email: row.email, phone: row.phone });
        }
      }

      const clientRows = customers.map((c) => {
        const contact = mergeClientContact(c, existingContactByQboId.get(c.Id));
        return {
          subscriber_id: subscriberId,
          source: "qbo",
          external_id: c.Id,
          name: c.DisplayName ?? c.Id,
          email: contact.email,
          phone: contact.phone,
        };
      });

      const { data: upsertedClients, error: clientError } = await service
        .from("clients")
        .upsert(clientRows, { onConflict: "subscriber_id,source,external_id" })
        .select("id, external_id");

      if (clientError) {
        throw new Error(`QBO sync: clients upsert failed: ${clientError.message}`);
      }

      customersUpserted = upsertedClients?.length ?? 0;
      for (const row of upsertedClients ?? []) {
        // external_id is the QBO Customer Id we just wrote; map it to our uuid.
        if (row.external_id) clientIdByQboId.set(row.external_id, row.id);
      }
    }

    // --- Invoices → invoices ---------------------------------------------
    // Resolve client_id via CustomerRef.value (= QBO Customer Id). An invoice
    // pointing at a customer we didn't sync is skipped, not fatal.
    let invoicesSkipped = 0;
    const invoiceRows: {
      subscriber_id: string;
      client_id: string;
      source: string;
      external_id: string;
      invoice_number: string | null;
      amount_cents: number;
      due_date: string | null;
    }[] = [];

    for (const inv of invoices) {
      const qboCustomerId = inv.CustomerRef?.value;
      const clientId = qboCustomerId ? clientIdByQboId.get(qboCustomerId) : undefined;
      if (!clientId) {
        invoicesSkipped++;
        continue;
      }

      invoiceRows.push({
        subscriber_id: subscriberId,
        client_id: clientId,
        source: "qbo",
        external_id: inv.Id,
        invoice_number: inv.DocNumber ?? null,
        // QBO returns dollars; store bigint cents. Round to avoid float drift.
        amount_cents: Math.round(inv.TotalAmt * 100),
        due_date: inv.DueDate ?? null,
        // NB: amount_outstanding_cents is a GENERATED column
        // (amount_cents - amount_paid_cents) — writing it errors, so it's omitted.
      });
    }

    let invoicesUpserted = 0;
    if (invoiceRows.length > 0) {
      const { data: upsertedInvoices, error: invoiceError } = await service
        .from("invoices")
        .upsert(invoiceRows, { onConflict: "subscriber_id,source,external_id" })
        .select("id");

      if (invoiceError) {
        throw new Error(`QBO sync: invoices upsert failed: ${invoiceError.message}`);
      }

      invoicesUpserted = upsertedInvoices?.length ?? 0;
    }

    // --- Outreach eligibility (Brick A) ----------------------------------
    // Post-invoice seam. For each eligible past-due, contactable invoice with no
    // prior attempt, record ONE simulated recovery_attempts row (sent_at set) so
    // the capture gate's outreach attribution is satisfied. Option B stub — no
    // real send; rows are marked SIMULATION and carry communication_id = null.
    // Does not alter the invoice/client sync above; failure throws → 500 like the
    // rest of the sync. Read subscriber-scoped source='qbo'; evaluate in the pure
    // engine; bulk-insert new rows via the existing service client.
    let outreachAttemptsCreated = 0;
    {
      const [invoicesRes, clientsRes, attemptsRes] = await Promise.all([
        service
          .from("invoices")
          .select("id, subscriber_id, client_id, due_date")
          .eq("subscriber_id", subscriberId)
          .eq("source", "qbo"),
        service
          .from("clients")
          .select("id, email, phone")
          .eq("subscriber_id", subscriberId)
          .eq("source", "qbo"),
        // Idempotency skip-set: any invoice with an existing attempt (any source).
        service
          .from("recovery_attempts")
          .select("invoice_id")
          .eq("subscriber_id", subscriberId),
      ]);

      if (invoicesRes.error) {
        throw new Error(`QBO sync: eligibility invoices read failed: ${invoicesRes.error.message}`);
      }
      if (clientsRes.error) {
        throw new Error(`QBO sync: eligibility clients read failed: ${clientsRes.error.message}`);
      }
      if (attemptsRes.error) {
        throw new Error(`QBO sync: eligibility attempts read failed: ${attemptsRes.error.message}`);
      }

      const existingAttemptInvoiceIds = new Set(
        (attemptsRes.data ?? []).map((r) => r.invoice_id),
      );
      const rows = evaluateOutreachEligibility(
        invoicesRes.data ?? [],
        clientsRes.data ?? [],
        existingAttemptInvoiceIds,
        new Date(),
      );

      if (rows.length > 0) {
        const { error: insertError } = await service.from("recovery_attempts").insert(rows);
        if (insertError) {
          throw new Error(`QBO sync: recovery_attempts insert failed: ${insertError.message}`);
        }
        outreachAttemptsCreated = rows.length;
      }
    }

    return NextResponse.json({
      customersUpserted,
      invoicesUpserted,
      invoicesSkipped,
      outreachAttemptsCreated,
    });
  } catch (err) {
    // The QBO client strips access tokens from its error messages, so echoing
    // the message here is safe. Any throw (token lookup, QBO fetch, upsert) → 500.
    const message = err instanceof Error ? err.message : "QBO sync failed";
    console.error("qbo/sync: failed", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

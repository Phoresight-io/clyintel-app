import { getSupabase } from "@/lib/supabase";
import { getValidAccessToken } from "@/lib/qbo/tokens";
import { listCustomers, listInvoices } from "@/lib/qbo/client";
import { mergeClientContact } from "@/lib/qbo/mergeClientContact";
import { evaluateOutreachEligibility } from "@/lib/outreach/eligibility";
import { computeBalanceEvent, type BalanceEventRow } from "@/lib/balanceEvents/computeBalanceEvent";
import type { QboSyncResult } from "@/lib/qbo/syncQbo";
import type { Database, Json } from "@/types/supabase";

type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];

// Server-side QuickBooks Online full-intake sync, parameterized on the
// subscriber id. This is the single implementation of the sync work; the
// /api/qbo/sync POST handler (browser-triggered via lib/qbo/syncQbo) and the
// OAuth callback (auto-sync on reauthorize) both call this with the subscriber
// they've already resolved, so subscriber resolution is the CALLER's job — this
// function never reads auth.getUser itself.
//
// For the authenticated subscriber: pull every Customer + Invoice from QBO and
// upsert them into clients / invoices.
//
// Reads/writes use the service-role client (getSupabase) so the bulk upsert
// isn't gated by per-row RLS — every row is stamped subscriber_id = the passed
// id, so the write stays scoped to that subscriber.
//
// Idempotent: upserts key on (subscriber_id, source, external_id) with
// source = 'qbo', so re-running updates in place and never duplicates.
//
// Transport/persistence only: NO past-due logic (that's the adapter's job), no
// dollar formatting beyond dollars→cents, no cron, no UI. Throws on any failure
// (token lookup, QBO fetch, upsert) — the caller decides how to surface it.

// Derive a synced invoice's status from QBO's authoritative figures at sync
// time, rather than letting the column DEFAULT ('draft') stand — a synced QBO
// invoice has been issued, so 'draft' is never correct for it. QBO `Balance` is
// the outstanding amount and `TotalAmt` the face value:
//   paid    → nothing outstanding
//   partial → some paid, but a balance remains
//   overdue → outstanding and past its due date
//   sent    → outstanding, not yet due (or no due date)
// `todayIso` and QBO DueDate are both YYYY-MM-DD, so a lexicographic compare is
// a correct date comparison. NB: amount_paid_cents is intentionally NOT written
// by this sync (amounts are out of scope); status is derived from QBO Balance
// directly, so a partially/fully-paid QBO invoice could show a status that the
// (unmapped) stored amount_paid_cents doesn't reflect — see PR notes.
function deriveInvoiceStatus(
  totalAmtCents: number,
  balanceCents: number,
  dueDate: string | null,
  todayIso: string,
): InvoiceStatus {
  if (balanceCents <= 0) return "paid";
  if (totalAmtCents - balanceCents > 0) return "partial";
  if (dueDate && dueDate < todayIso) return "overdue";
  return "sent";
}

export async function runQboSync(subscriberId: string): Promise<QboSyncResult> {
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
    amount_paid_cents: number;
    due_date: string | null;
    issue_date: string | null;
    status: InvoiceStatus;
    raw_source_data: Json;
  }[] = [];

  // Single "today" for the whole batch (UTC date), so status derivation is
  // consistent across all rows in this sync.
  const todayIso = new Date().toISOString().slice(0, 10);

  // New outstanding (cents) per QBO invoice Id for this batch, = amount_cents −
  // amount_paid_cents (exactly the value the GENERATED amount_outstanding_cents
  // column will hold post-upsert). Feeds balance-drop detection below.
  const newOutstandingByExternalId = new Map<string, number>();

  for (const inv of invoices) {
    const qboCustomerId = inv.CustomerRef?.value;
    const clientId = qboCustomerId ? clientIdByQboId.get(qboCustomerId) : undefined;
    if (!clientId) {
      invoicesSkipped++;
      continue;
    }

    // QBO returns dollars; store bigint cents. Round to avoid float drift.
    const amountCents = Math.round(inv.TotalAmt * 100);
    // QBO Balance is the outstanding amount; if absent, treat as fully
    // outstanding (= face) so a missing balance never looks paid.
    const balanceCents =
      inv.Balance != null ? Math.round(inv.Balance * 100) : amountCents;
    // Paid = face − outstanding. Clamp to [0, amountCents] so an odd QBO
    // Balance (negative → overpayment, or > TotalAmt) can never write a
    // negative paid amount or one exceeding the face — keeps the GENERATED
    // amount_outstanding_cents (= amount_cents − amount_paid_cents) in [0, face]
    // and consistent with the derived status.
    const paidCents = Math.max(0, Math.min(amountCents, amountCents - balanceCents));
    // Record the new outstanding (= face − paid) for balance-drop detection.
    newOutstandingByExternalId.set(inv.Id, amountCents - paidCents);
    // TxnDate (issue date) rides on the raw QBO payload, not the typed list
    // item; SELECT * returns it. May be absent → null.
    const txnDate =
      (inv.raw as { TxnDate?: string } | undefined)?.TxnDate ?? null;

    invoiceRows.push({
      subscriber_id: subscriberId,
      client_id: clientId,
      source: "qbo",
      external_id: inv.Id,
      invoice_number: inv.DocNumber ?? null,
      amount_cents: amountCents,
      // QBO paid amount (TotalAmt − Balance), so amount_paid_cents matches the
      // Balance-derived status. Was unmapped (default 0), which left paid/
      // partial rows contradicting their status; now consistent. The GENERATED
      // amount_outstanding_cents self-corrects to QBO Balance.
      amount_paid_cents: paidCents,
      due_date: inv.DueDate ?? null,
      // QBO TxnDate → issue_date (was previously unmapped → NULL).
      issue_date: txnDate,
      // Derived explicitly so the column DEFAULT ('draft') never decides a
      // real synced invoice's status.
      status: deriveInvoiceStatus(amountCents, balanceCents, inv.DueDate ?? null, todayIso),
      // Full QBO invoice payload for audit / re-derivation (was unmapped → NULL).
      raw_source_data: (inv.raw ?? null) as Json,
      // NB: amount_outstanding_cents is a GENERATED column
      // (amount_cents - amount_paid_cents) — writing it errors, so it's omitted.
    });
  }

  // --- Balance-drop anchors (PRE-upsert, best-effort) ------------------
  // Resolve each invoice's PREVIOUS outstanding balance BEFORE the upsert
  // overwrites it — otherwise the drop is unrecoverable. Anchor precedence:
  //   1. balance_events last new_outstanding_cents (durable monotonic ledger),
  //   2. else existing invoices.amount_outstanding_cents (never-evented invoice),
  //   3. else null (brand-new invoice → no anchor, no emission).
  // reminder_count is read here too (the emission-time value). This whole block
  // is additive and must NEVER abort invoice sync. The two reads are split so a
  // failure of the best-effort ledger override can never wipe the invoice-seeded
  // base anchors: only an invoices pre-read failure (no reliable base) skips
  // emission; a ledger-read failure just skips the override.
  const anchorByExternalId = new Map<
    string,
    { prevOutstandingCents: number | null; reminderCount: number }
  >();
  const uuidByExternalId = new Map<string, string>();
  const externalIds = invoiceRows.map((r) => r.external_id);
  if (externalIds.length > 0) {
    // Base anchors: one batched read of existing invoices in this batch
    // (fallback anchor + reminder_count + the uuid needed to look up their
    // ledger events). If THIS fails there is no reliable base, so clear and
    // let emission no-op this run.
    try {
      const { data: preInvoices, error: preError } = await service
        .from("invoices")
        .select("id, external_id, amount_outstanding_cents, reminder_count")
        .eq("subscriber_id", subscriberId)
        .eq("source", "qbo")
        .in("external_id", externalIds);
      if (preError) throw new Error(preError.message);

      for (const row of preInvoices ?? []) {
        if (!row.external_id) continue;
        uuidByExternalId.set(row.external_id, row.id);
        anchorByExternalId.set(row.external_id, {
          prevOutstandingCents: row.amount_outstanding_cents,
          reminderCount: row.reminder_count ?? 0,
        });
      }
    } catch (err) {
      console.error(
        "qbo/sync: balance-event anchor read failed (emission skipped this run)",
        err,
      );
      anchorByExternalId.clear();
      uuidByExternalId.clear();
    }

    // Ledger-last override: a best-effort ENHANCEMENT over the invoice-seeded
    // base anchors. One batched read of the latest balance_events per known
    // invoice uuid (newest-first; first row seen per invoice_id is its latest).
    // On failure, KEEP the base anchors (do NOT clear) so first-observation
    // drops still emit — just skip the override this run.
    const uuids = [...uuidByExternalId.values()];
    if (uuids.length > 0) {
      try {
        const { data: events, error: evError } = await service
          .from("balance_events")
          .select("invoice_id, new_outstanding_cents, detected_at")
          .in("invoice_id", uuids)
          .order("detected_at", { ascending: false });
        if (evError) throw new Error(evError.message);

        const lastEventByInvoiceId = new Map<string, number>();
        for (const ev of events ?? []) {
          if (!lastEventByInvoiceId.has(ev.invoice_id)) {
            lastEventByInvoiceId.set(ev.invoice_id, ev.new_outstanding_cents);
          }
        }
        // The ledger anchor, where present, overrides the invoices fallback.
        for (const [ext, uuid] of uuidByExternalId) {
          const last = lastEventByInvoiceId.get(uuid);
          if (last != null) {
            anchorByExternalId.set(ext, {
              prevOutstandingCents: last,
              reminderCount: anchorByExternalId.get(ext)?.reminderCount ?? 0,
            });
          }
        }
      } catch (err) {
        console.error(
          "qbo/sync: balance-event anchor read failed (ledger override skipped this run)",
          err,
        );
      }
    }
  }

  let invoicesUpserted = 0;
  // QBO external_id → our invoices.id (uuid) for every upserted row, incl. brand
  // new ones (their uuids only exist post-upsert). Drives balance emission below.
  const upsertedIdByExternalId = new Map<string, string>();
  if (invoiceRows.length > 0) {
    const { data: upsertedInvoices, error: invoiceError } = await service
      .from("invoices")
      .upsert(invoiceRows, { onConflict: "subscriber_id,source,external_id" })
      .select("id, external_id");

    if (invoiceError) {
      throw new Error(`QBO sync: invoices upsert failed: ${invoiceError.message}`);
    }

    invoicesUpserted = upsertedInvoices?.length ?? 0;
    for (const row of upsertedInvoices ?? []) {
      if (row.external_id) upsertedIdByExternalId.set(row.external_id, row.id);
    }
  }

  // --- Balance-drop emission (POST-upsert, best-effort) ----------------
  // Invoice uuids now exist for brand-new rows too. Compare each invoice's
  // PRE-upsert anchor against its new outstanding and record one balance_events
  // row per detected drop. prev comes from the pre-upsert anchor — never
  // re-derived from the just-written new state. computeBalanceEvent guarantees
  // every emitted row satisfies the DB CHECK constraints. A failed insert is
  // logged loudly, never swallowed, and never aborts the sync (money path).
  let balanceEventsEmitted = 0;
  {
    const syncedAt = new Date().toISOString();
    const balanceEventRows: BalanceEventRow[] = [];
    for (const [externalId, newOutstandingCents] of newOutstandingByExternalId) {
      const invoiceId = upsertedIdByExternalId.get(externalId);
      if (!invoiceId) continue; // upsert didn't return this row; nothing to reference
      const anchor = anchorByExternalId.get(externalId);
      const row = computeBalanceEvent({
        subscriberId,
        invoiceId,
        source: "qbo",
        prevOutstandingCents: anchor?.prevOutstandingCents ?? null,
        newOutstandingCents,
        reminderCount: anchor?.reminderCount ?? 0,
        syncedAt,
      });
      if (row) balanceEventRows.push(row);
    }

    if (balanceEventRows.length > 0) {
      const { error: emitError } = await service
        .from("balance_events")
        .insert(balanceEventRows);
      if (emitError) {
        console.error(
          `qbo/sync: balance_events insert failed (${balanceEventRows.length} rows dropped): ${emitError.message}`,
        );
      } else {
        balanceEventsEmitted = balanceEventRows.length;
      }
    }
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

  return {
    customersUpserted,
    invoicesUpserted,
    invoicesSkipped,
    outreachAttemptsCreated,
    balanceEventsEmitted,
  };
}

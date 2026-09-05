import { getSupabase } from "@/lib/supabase";
import { sendEmail } from "@/lib/email";
import { selectFromContacts, type ContactRow } from "@/lib/outreach/selectRecipients";
import { isChannelAllowed } from "@/lib/outreach/isChannelAllowed";
import type { Database } from "@/types/supabase";

// Recorded, gated, DRY-RUN-FIRST email send step (Brick 1a).
//
// This writes the send RECORD (communications row + linked recovery_attempts
// row) and drives status, but in dry-run mode it does NOT call MailerSend. Live
// send is a mode flag flipped only after the row/link plumbing is verified on
// prod. No trigger/cron here (that is Brick 1c) — this is an invocable function.
//
// GATE ORDER (hard, do not reorder):
//   1. selectRecipients → primary contact. None (email-less client) → clean no-op.
//   2. isChannelAllowed(contact, "email") → DETERMINISTIC opt-out gate. Denied →
//      write NOTHING and exit (there is no `skipped` recovery_attempts convention
//      in the codebase yet, so we do not invent one).
//   3. Only AFTER the gate passes do we render the template. Template rendering is
//      the ONLY place an LLM may ever touch this path (variable-fill), and it is
//      strictly downstream of the compliance gate. 1a uses deterministic
//      {{variable}} substitution (no LLM, no network) — the LLM fill seam plugs in
//      here later, still after the gate.
//   3b. Payment-link gate (Brick B): resolve the link (client → subscriber →
//      [Connect stub]). No link → suppress: write NOTHING and exit with outcome
//      no_payment_link, mirroring the compliance gate. Placed AFTER the template
//      load, BEFORE the pre-send record. Existing gates are NOT reordered.
//   4. Pre-send communications row (status "pending") is written BEFORE any send,
//      so a send-succeeds / record-fails can never silently double-send: we never
//      dispatch without an existing record to reconcile.

type TemplateRow = Database["public"]["Tables"]["templates"]["Row"];

export type SendMode = "dry_run" | "live";

// communications.status is free text in the DB — this const is the only guardrail.
// `would_send` is the dry-run terminal state: a record exists, nothing was sent.
export const COMM_STATUS = {
  pending: "pending",
  wouldSend: "would_send",
  sent: "sent",
  failed: "failed",
} as const;
export type CommStatus = (typeof COMM_STATUS)[keyof typeof COMM_STATUS];

const FROM_ADDRESS = "team@phoresight.io"; // matches lib/email.ts sender

export interface SendEmailStepContext {
  subscriberId: string;
  clientId: string;
  invoiceId: string;
}

export type SendEmailOutcome =
  | "no_primary_contact" // email-less client → nothing sendable
  | "channel_denied" // opt-out gate denied → nothing written
  | "no_template" // misconfig: no active system-default email template
  | "no_payment_link" // no resolvable payment link (client→subscriber→[Connect stub]) → suppressed, nothing written
  | "would_send" // dry-run: recorded, not sent
  | "sent" // live: recorded + sent
  | "send_failed"; // live: MailerSend threw; recorded as failed

export interface SendEmailStepResult {
  outcome: SendEmailOutcome;
  communicationId: string | null;
  recoveryAttemptId: string | null;
  mailersendMessageId: string | null;
}

// Variables the template can reference. The live system-default template
// references all of these; `payment_link` is the raw resolved URL ("" when none,
// which the payment-link gate treats as no-link).
export interface RenderVars {
  client_name: string;
  invoice_number: string;
  amount_due: string;
  due_date: string;
  invoice_date: string;
  subscriber_name: string;
  payment_link: string;
}

// ── Pure helpers (unit-tested without I/O) ───────────────────────────────────

/** Deterministic {{key}} substitution. Unknown {{tokens}} are left intact (never
 *  guessed). No LLM. */
export function renderTemplate(text: string, vars: RenderVars): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    const v = (vars as unknown as Record<string, string>)[key];
    return v === undefined ? whole : v;
  });
}

/** The real attempt's number is one past the highest existing attempt on the
 *  invoice — including any SIMULATION row — so the numbering never lies. */
export function nextAttemptNumber(existing: readonly number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

/** Resolve the payment link to render/gate on: client link wins, else the
 *  subscriber's account-level default, else null. Pure, no I/O. Path A (Stripe
 *  Connect) is a STUBBED SEAM here — B does not build Connect; when it lands, a
 *  resolved Connect link would slot into the marked branch before the final
 *  null. Whitespace-only values are treated as absent. */
export function resolvePaymentLink(
  clientLink: string | null | undefined,
  subscriberLink: string | null | undefined,
): string | null {
  const client = (clientLink ?? "").trim();
  if (client !== "") return client;
  const subscriber = (subscriberLink ?? "").trim();
  if (subscriber !== "") return subscriber;
  // [Connect stub] Path A — no build in Brick B. A resolved Stripe Connect
  // payment link would return here, ahead of the null fallthrough:
  //   const connect = resolveConnectPaymentLink(...); if (connect) return connect;
  return null;
}

/** HTML-escape a value for safe interpolation into both text nodes and quoted
 *  attribute values. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the template body to an escaped HTML string. Every literal chunk and
 *  every variable value is HTML-escaped; `{{payment_link}}` becomes an anchor
 *  (`<a href="URL">URL</a>`, URL escaped for both the href and the label);
 *  unknown tokens are left as escaped literals (never guessed); newlines become
 *  <br>. The anchor is the ONLY markup this produces, so no substituted value
 *  can inject HTML. */
export function renderHtmlBody(text: string, vars: RenderVars): string {
  const re = /\{\{\s*(\w+)\s*\}\}/g;
  const lookup = vars as unknown as Record<string, string>;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const key = m[1];
    const raw = lookup[key];
    if (raw === undefined) {
      out += escapeHtml(m[0]); // unknown token → keep literal, escaped
    } else if (key === "payment_link") {
      out += raw === "" ? "" : `<a href="${escapeHtml(raw)}">${escapeHtml(raw)}</a>`;
    } else {
      out += escapeHtml(raw);
    }
    last = re.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out.replace(/\n/g, "<br>");
}

// ── Port: the I/O this step needs. Real impl below; tests inject a fake. ──────
export interface SendEmailPort {
  loadPrimaryContact(clientId: string): Promise<ContactRow | null>;
  loadActiveSystemDefaultEmailTemplate(): Promise<TemplateRow | null>;
  loadRenderVars(ctx: SendEmailStepContext): Promise<RenderVars | null>;
  loadExistingAttemptNumbers(invoiceId: string): Promise<number[]>;
  insertPendingCommunication(row: {
    subscriber_id: string;
    client_id: string;
    invoice_id: string;
    template_id: string;
    to_address: string;
    from_address: string;
    subject: string;
    body: string;
  }): Promise<string>; // returns communications.id
  finalizeCommunication(
    id: string,
    patch: { status: CommStatus; mailersend_message_id: string | null; sent_at: string | null },
  ): Promise<void>;
  insertRecoveryAttempt(row: {
    subscriber_id: string;
    client_id: string;
    invoice_id: string;
    communication_id: string;
    attempt_number: number;
    status: Database["public"]["Enums"]["recovery_status"];
    sent_at: string | null;
  }): Promise<string>; // returns recovery_attempts.id
  dispatchEmail(params: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId: string | null }>;
  now(): string; // ISO timestamp (injectable for deterministic tests)
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function sendEmailStep(
  ctx: SendEmailStepContext,
  mode: SendMode,
  port: SendEmailPort = createDefaultPort(),
): Promise<SendEmailStepResult> {
  const empty: SendEmailStepResult = {
    outcome: "no_primary_contact",
    communicationId: null,
    recoveryAttemptId: null,
    mailersendMessageId: null,
  };

  // 1. Primary contact (email-less client → clean no-op, nothing written).
  const contact = await port.loadPrimaryContact(ctx.clientId);
  if (!contact) return empty;

  // 2. Compliance gate — deterministic, fail-closed. Denied → write nothing.
  if (!isChannelAllowed(contact, "email")) {
    return { ...empty, outcome: "channel_denied" };
  }
  if (!contact.email || contact.email.trim() === "") {
    // Primary exists but has no email address → not sendable on this channel.
    return { ...empty, outcome: "channel_denied" };
  }

  // 3. Template (gate has passed) + deterministic render.
  const template = await port.loadActiveSystemDefaultEmailTemplate();
  if (!template) return { ...empty, outcome: "no_template" };
  const vars = (await port.loadRenderVars(ctx)) ?? {
    client_name: "",
    invoice_number: "",
    amount_due: "",
    due_date: "",
    invoice_date: "",
    subscriber_name: "",
    payment_link: "",
  };

  // 3b. Payment-link gate — a resolved link is REQUIRED. None → suppress: write
  //     NOTHING, mirror the compliance-gate no-op. loadRenderVars already ran
  //     resolvePaymentLink (client → subscriber → [Connect stub]); "" means none.
  if (!vars.payment_link) {
    return { ...empty, outcome: "no_payment_link" };
  }

  const subject = renderTemplate(template.subject ?? "", vars);
  // text body: {{payment_link}} renders as the raw URL; stored in communications.body.
  const body = renderTemplate(template.body ?? "", vars);
  // html body: escaped, {{payment_link}} as <a href>; sent as html only, NOT stored.
  const htmlBody = renderHtmlBody(template.body ?? "", vars);

  // 4. Pre-send record (status "pending") BEFORE any dispatch → no send without a
  //    row to reconcile.
  const communicationId = await port.insertPendingCommunication({
    subscriber_id: ctx.subscriberId,
    client_id: ctx.clientId,
    invoice_id: ctx.invoiceId,
    template_id: template.id,
    to_address: contact.email,
    from_address: FROM_ADDRESS,
    subject,
    body,
  });

  // Dispatch (or not) + finalize the communication.
  let commStatus: CommStatus;
  let messageId: string | null = null;
  let sentAt: string | null = null;
  let outcome: SendEmailOutcome;

  if (mode === "live") {
    try {
      const res = await port.dispatchEmail({ to: contact.email, subject, text: body, html: htmlBody });
      messageId = res.messageId;
      sentAt = port.now();
      commStatus = COMM_STATUS.sent;
      outcome = "sent";
    } catch {
      commStatus = COMM_STATUS.failed;
      outcome = "send_failed";
    }
  } else {
    // dry-run: record only, no MailerSend call.
    commStatus = COMM_STATUS.wouldSend;
    outcome = "would_send";
  }

  await port.finalizeCommunication(communicationId, {
    status: commStatus,
    mailersend_message_id: messageId,
    sent_at: sentAt,
  });

  // Link a fresh REAL recovery_attempts row (counted_toward_limit defaults true).
  // dry-run/failed → "scheduled" (a recorded attempt that was not dispatched);
  // live success → "sent". Numbered past any existing attempt (incl. SIMULATION).
  const existingNums = await port.loadExistingAttemptNumbers(ctx.invoiceId);
  const recoveryStatus = outcome === "sent" ? "sent" : "scheduled";
  const recoveryAttemptId = await port.insertRecoveryAttempt({
    subscriber_id: ctx.subscriberId,
    client_id: ctx.clientId,
    invoice_id: ctx.invoiceId,
    communication_id: communicationId,
    attempt_number: nextAttemptNumber(existingNums),
    status: recoveryStatus,
    sent_at: sentAt,
  });

  return { outcome, communicationId, recoveryAttemptId, mailersendMessageId: messageId };
}

// ── Default (real) port over Supabase + the seams ────────────────────────────
function createDefaultPort(): SendEmailPort {
  const service = getSupabase();
  return {
    async loadPrimaryContact(clientId) {
      const { data, error } = await service
        .from("client_contacts")
        .select("*")
        .eq("client_id", clientId);
      if (error) {
        console.error("sendEmailStep: client_contacts read failed", error);
        return null; // fail closed → treated as unsendable
      }
      return selectFromContacts(data ?? [])[0] ?? null;
    },
    async loadActiveSystemDefaultEmailTemplate() {
      const { data, error } = await service
        .from("templates")
        .select("*")
        .eq("is_system_default", true)
        .eq("is_active", true)
        .eq("channel", "email")
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error("sendEmailStep: template read failed", error);
        return null;
      }
      return data ?? null;
    },
    async loadRenderVars(ctx) {
      const { data: inv } = await service
        .from("invoices")
        .select("invoice_number, amount_outstanding_cents, due_date, issue_date")
        .eq("id", ctx.invoiceId)
        .maybeSingle();
      const { data: client } = await service
        .from("clients")
        .select("name, payment_link_url")
        .eq("id", ctx.clientId)
        .maybeSingle();
      const { data: subscriber } = await service
        .from("subscribers")
        .select("payment_link_url, business_name, contact_name")
        .eq("id", ctx.subscriberId)
        .maybeSingle();
      const cents = inv?.amount_outstanding_cents ?? 0;
      return {
        client_name: client?.name ?? "there",
        invoice_number: inv?.invoice_number ?? "",
        amount_due: `$${(cents / 100).toFixed(2)}`,
        due_date: inv?.due_date ?? "",
        // invoice_date mirrors due_date's raw formatting (the ISO date string as-is).
        invoice_date: inv?.issue_date ?? "",
        subscriber_name: subscriber?.business_name || subscriber?.contact_name || "our team",
        payment_link: resolvePaymentLink(client?.payment_link_url, subscriber?.payment_link_url) ?? "",
      };
    },
    async loadExistingAttemptNumbers(invoiceId) {
      const { data, error } = await service
        .from("recovery_attempts")
        .select("attempt_number")
        .eq("invoice_id", invoiceId);
      if (error) {
        console.error("sendEmailStep: recovery_attempts read failed", error);
        return [];
      }
      return (data ?? []).map((r) => r.attempt_number);
    },
    async insertPendingCommunication(row) {
      const { data, error } = await service
        .from("communications")
        .insert({
          subscriber_id: row.subscriber_id,
          client_id: row.client_id,
          invoice_id: row.invoice_id,
          template_id: row.template_id,
          channel: "email",
          direction: "outbound",
          to_address: row.to_address,
          from_address: row.from_address,
          subject: row.subject,
          body: row.body,
          status: COMM_STATUS.pending,
        })
        .select("id")
        .single();
      if (error || !data) {
        throw new Error(`sendEmailStep: communications insert failed: ${error?.message}`);
      }
      return data.id;
    },
    async finalizeCommunication(id, patch) {
      const { error } = await service
        .from("communications")
        .update({
          status: patch.status,
          mailersend_message_id: patch.mailersend_message_id,
          sent_at: patch.sent_at,
        })
        .eq("id", id);
      if (error) {
        throw new Error(`sendEmailStep: communications finalize failed: ${error.message}`);
      }
    },
    async insertRecoveryAttempt(row) {
      const { data, error } = await service
        .from("recovery_attempts")
        .insert({
          subscriber_id: row.subscriber_id,
          client_id: row.client_id,
          invoice_id: row.invoice_id,
          communication_id: row.communication_id,
          channel: "email",
          attempt_number: row.attempt_number,
          counted_toward_limit: true,
          status: row.status,
          scheduled_at: new Date().toISOString(),
          sent_at: row.sent_at,
        })
        .select("id")
        .single();
      if (error || !data) {
        throw new Error(`sendEmailStep: recovery_attempts insert failed: ${error?.message}`);
      }
      return data.id;
    },
    async dispatchEmail(params) {
      return sendEmail({ to: params.to, subject: params.subject, text: params.text, html: params.html });
    },
    now() {
      return new Date().toISOString();
    },
  };
}

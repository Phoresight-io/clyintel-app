// Public pay page — unauthenticated. Clients land here from the payment link
// emailed by ClyIntel. The token is opaque (32 random bytes, base64url) and
// never derived from the invoice id, so it cannot be guessed or enumerated.
//
// Flow:
//   1. Validate token: not-found / inactive / expired → dead-end page.
//   2. Recompute balance live via getRemainingBalance.
//   3. Read subscriber pay-gate flags.
//   4. No gate → mint Stripe Checkout Session → 302 to Stripe (server redirect).
//   5. Gate required → render challenge form; on submission verify via Server
//      Action → mint Session → 302 to Stripe. On mismatch → redirect to
//      ?error=1 (generic; does NOT reveal which field failed or the balance).
//
// IMPORTANT: the challenge page must never expose the invoice amount, invoice
// number, or client details in its rendered HTML before the gate is cleared.

import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { getRemainingBalance } from "@/lib/recovery/balance";
import { createRecoveryCheckoutSession } from "@/lib/stripe";

function getAppUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  const v = process.env.VERCEL_URL;
  if (v) return `https://${v}`;
  return "http://localhost:3000";
}

// Extract a zip/postal code from a JSON billing_address blob using common field names.
// Returns null if not found — callers must degrade gracefully.
function extractZip(billingAddress: unknown): string | null {
  if (!billingAddress || typeof billingAddress !== "object") return null;
  const addr = billingAddress as Record<string, unknown>;
  for (const key of ["zip", "postal_code", "postcode", "zipcode", "zip_code"]) {
    const val = addr[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; canceled?: string }>;
}

export default async function PayPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { error: hasError, canceled } = await searchParams;

  const service = getSupabase();

  // ── 1. Token lookup ─────────────────────────────────────────────────────────
  const { data: link } = await service
    .from("recovery_links")
    .select("id, invoice_id, subscriber_id, link_status, link_expires_at, token")
    .eq("token", token)
    .maybeSingle();

  if (!link) return <DeadEnd reason="invalid" />;

  const now = new Date();
  const expired = link.link_expires_at ? new Date(link.link_expires_at) < now : false;

  if (link.link_status === "paid") return <AlreadyPaid />;
  if (link.link_status !== "active" || expired) return <DeadEnd reason="expired" />;

  // ── 2. Live balance ─────────────────────────────────────────────────────────
  let balanceCents: number;
  try {
    balanceCents = await getRemainingBalance(link.invoice_id);
  } catch {
    return <DeadEnd reason="error" />;
  }

  if (balanceCents === 0) return <AlreadyPaid />;

  // ── 3. Gate flags + invoice/client data ────────────────────────────────────
  const [subResult, invoiceResult] = await Promise.all([
    service
      .from("subscribers")
      .select("pay_gate_require_invoice_number, pay_gate_require_zip, plan:plans(revenue_share_rate)")
      .eq("id", link.subscriber_id)
      .single(),
    service
      .from("invoices")
      .select("invoice_number, currency, client_id")
      .eq("id", link.invoice_id)
      .single(),
  ]);

  if (!subResult.data || !invoiceResult.data) return <DeadEnd reason="error" />;

  const sub = subResult.data;
  const invoice = invoiceResult.data;

  let requireInvoiceNum = sub.pay_gate_require_invoice_number;
  let requireZip = sub.pay_gate_require_zip;
  let billingZip: string | null = null;

  if (requireZip) {
    const { data: client } = await service
      .from("clients")
      .select("billing_address")
      .eq("id", invoice.client_id)
      .single();
    billingZip = extractZip(client?.billing_address);
    // Graceful degradation: no zip stored → drop zip requirement
    if (!billingZip) requireZip = false;
  }

  const gateRequired = requireInvoiceNum || requireZip;

  // ── 4. No gate → mint Session + redirect ────────────────────────────────────
  if (!gateRequired) {
    const { data: payout } = await service
      .from("payout_accounts")
      .select("provider_account_id")
      .eq("subscriber_id", link.subscriber_id)
      .eq("provider", "stripe")
      .eq("onboarding_status", "complete")
      .single();

    if (!payout?.provider_account_id) return <DeadEnd reason="error" />;

    const revShareRate =
      (sub.plan as { revenue_share_rate?: number } | null)?.revenue_share_rate ?? 0.18;
    const origin = getAppUrl();

    let sessionUrl: string;
    try {
      sessionUrl = await createRecoveryCheckoutSession({
        token,
        invoiceId: link.invoice_id,
        subscriberId: link.subscriber_id,
        providerAccountId: payout.provider_account_id,
        revShareRate,
        balanceCents,
        currency: invoice.currency,
        invoiceNumber: invoice.invoice_number,
        successUrl: `${origin}/pay/${token}/done`,
        cancelUrl: `${origin}/pay/${token}?canceled=1`,
      });
    } catch {
      return <DeadEnd reason="error" />;
    }

    redirect(sessionUrl);
  }

  // ── 5. Gate required → challenge form ───────────────────────────────────────
  // Server Action: verify fields, mint Session, redirect.
  // Closes over token only — everything else is re-fetched server-side.
  async function verifyChallenge(formData: FormData) {
    "use server";

    const svc = getSupabase();

    // Re-validate token (idempotent, prevents replays on voided links)
    const { data: lnk } = await svc
      .from("recovery_links")
      .select("id, invoice_id, subscriber_id, link_status, link_expires_at")
      .eq("token", token)
      .maybeSingle();

    const linkNow = new Date();
    const linkExpired = lnk?.link_expires_at
      ? new Date(lnk.link_expires_at) < linkNow
      : false;

    if (!lnk || lnk.link_status !== "active" || linkExpired) {
      redirect(`/pay/${token}?error=1`);
    }

    const balance = await getRemainingBalance(lnk.invoice_id);
    if (balance === 0) redirect(`/pay/${token}?error=1`);

    // Re-fetch canonical gate values inside the action (never trust closed-over
    // user-facing data; only trust data re-read with service-role).
    const [subRes, invRes] = await Promise.all([
      svc
        .from("subscribers")
        .select("pay_gate_require_invoice_number, pay_gate_require_zip, plan:plans(revenue_share_rate)")
        .eq("id", lnk.subscriber_id)
        .single(),
      svc
        .from("invoices")
        .select("invoice_number, currency, client_id")
        .eq("id", lnk.invoice_id)
        .single(),
    ]);

    if (!subRes.data || !invRes.data) redirect(`/pay/${token}?error=1`);

    const subData = subRes.data!;
    const invData = invRes.data!;

    let gateRequireInvoiceNum = subData.pay_gate_require_invoice_number;
    let gateRequireZip = subData.pay_gate_require_zip;
    let canonicalZip: string | null = null;

    if (gateRequireZip) {
      const { data: cl } = await svc
        .from("clients")
        .select("billing_address")
        .eq("id", invData.client_id)
        .single();
      canonicalZip = extractZip(cl?.billing_address);
      if (!canonicalZip) gateRequireZip = false; // graceful degradation
    }

    // Validate submitted fields
    if (gateRequireInvoiceNum) {
      const canonical = (invData.invoice_number ?? "").trim().toLowerCase();
      const entered = ((formData.get("invoice_number") as string) ?? "").trim().toLowerCase();
      if (!canonical || canonical !== entered) redirect(`/pay/${token}?error=1`);
    }

    if (gateRequireZip && canonicalZip) {
      const canonical = canonicalZip.trim().toLowerCase();
      const entered = ((formData.get("zip") as string) ?? "").trim().toLowerCase();
      if (!canonical || canonical !== entered) redirect(`/pay/${token}?error=1`);
    }

    // Gate cleared — mint Session
    const { data: po } = await svc
      .from("payout_accounts")
      .select("provider_account_id")
      .eq("subscriber_id", lnk.subscriber_id)
      .eq("provider", "stripe")
      .eq("onboarding_status", "complete")
      .single();

    if (!po?.provider_account_id) redirect(`/pay/${token}?error=1`);

    const rate =
      (subData.plan as { revenue_share_rate?: number } | null)?.revenue_share_rate ?? 0.18;
    const appUrl = getAppUrl();

    let sUrl: string;
    try {
      sUrl = await createRecoveryCheckoutSession({
        token,
        invoiceId: lnk.invoice_id,
        subscriberId: lnk.subscriber_id,
        providerAccountId: po!.provider_account_id!,
        revShareRate: rate,
        balanceCents: balance,
        currency: invData.currency,
        invoiceNumber: invData.invoice_number,
        successUrl: `${appUrl}/pay/${token}/done`,
        cancelUrl: `${appUrl}/pay/${token}?canceled=1`,
      });
    } catch {
      redirect(`/pay/${token}?error=1`);
    }

    redirect(sUrl!);
  }

  return (
    <ChallengeForm
      action={verifyChallenge}
      requireInvoiceNum={requireInvoiceNum}
      requireZip={requireZip}
      hasError={!!hasError}
      canceled={!!canceled}
    />
  );
}

// ── UI components ────────────────────────────────────────────────────────────

const styles = {
  page: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    fontFamily: "system-ui, -apple-system, sans-serif",
    background: "#f8fafb",
    padding: "24px",
  },
  card: {
    maxWidth: 440,
    width: "100%",
    background: "#fff",
    borderRadius: 16,
    padding: "40px 36px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
  },
  h1: {
    fontSize: 20,
    fontWeight: 700,
    color: "#0f172a",
    margin: "0 0 10px",
  },
  body: {
    fontSize: 14,
    color: "#64748b",
    fontWeight: 500,
    margin: "0 0 24px",
    lineHeight: 1.6,
  },
  label: {
    display: "block" as const,
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 6,
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    fontSize: 14,
    color: "#0f172a",
    background: "#f8fafb",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    outline: "none",
    boxSizing: "border-box" as const,
    marginBottom: 16,
  },
  btn: {
    width: "100%",
    padding: "11px 18px",
    fontSize: 15,
    fontWeight: 600,
    color: "#fff",
    background: "#3b82f6",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    marginTop: 4,
  },
  errorBox: {
    padding: "10px 14px",
    borderRadius: 8,
    background: "#fef2f2",
    border: "1px solid #fca5a5",
    fontSize: 13,
    fontWeight: 500,
    color: "#dc2626",
    marginBottom: 20,
  },
};

function DeadEnd({ reason }: { reason: "invalid" | "expired" | "error" }) {
  const messages: Record<string, { title: string; body: string }> = {
    invalid: {
      title: "Link not found",
      body: "This payment link doesn't exist or has already been used. Please contact the business that sent it.",
    },
    expired: {
      title: "Link expired",
      body: "This payment link is no longer active. Please contact the business that sent it to request a new one.",
    },
    error: {
      title: "Something went wrong",
      body: "We couldn't process this payment link right now. Please try again or contact the business that sent it.",
    },
  };
  const { title, body } = messages[reason];
  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>{title}</h1>
        <p style={styles.body}>{body}</p>
      </div>
    </main>
  );
}

function AlreadyPaid() {
  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Already paid</h1>
        <p style={styles.body}>
          This invoice has already been paid in full. Thank you — you can close
          this page.
        </p>
      </div>
    </main>
  );
}

function ChallengeForm({
  action,
  requireInvoiceNum,
  requireZip,
  hasError,
  canceled,
}: {
  action: (formData: FormData) => Promise<void>;
  requireInvoiceNum: boolean;
  requireZip: boolean;
  hasError: boolean;
  canceled: boolean;
}) {
  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Verify your identity</h1>
        <p style={styles.body}>
          To continue to payment, please confirm the details below.
        </p>

        {canceled && !hasError && (
          <div
            style={{
              ...styles.errorBox,
              background: "#fffbeb",
              border: "1px solid #fcd34d",
              color: "#92400e",
            }}
          >
            Checkout was cancelled — no payment was taken. You can try again below.
          </div>
        )}

        {hasError && (
          <div style={styles.errorBox}>
            The details you entered don&apos;t match our records. Please check
            and try again.
          </div>
        )}

        <form action={action}>
          {requireInvoiceNum && (
            <div>
              <label htmlFor="invoice_number" style={styles.label}>
                Invoice number
              </label>
              <input
                id="invoice_number"
                name="invoice_number"
                type="text"
                autoComplete="off"
                required
                placeholder="e.g. INV-0042"
                style={styles.input}
              />
            </div>
          )}

          {requireZip && (
            <div>
              <label htmlFor="zip" style={styles.label}>
                Billing ZIP / postal code
              </label>
              <input
                id="zip"
                name="zip"
                type="text"
                autoComplete="postal-code"
                required
                placeholder="e.g. 90210"
                style={styles.input}
              />
            </div>
          )}

          <button type="submit" style={styles.btn}>
            Continue to payment
          </button>
        </form>
      </div>
    </main>
  );
}

// Provider-agnostic payout-rail config. Each payout provider (Stripe today,
// PayPal later) is described by one PaymentProvider so UI copy, fee disclosure,
// onboarding entry points, and account-id formatting are keyed by provider
// rather than hardcoded as Stripe literals. See PRD v2.2 §2 (Revenue Share).

export type ProviderId = "stripe" | "paypal";

export interface PaymentProvider {
  /** Stable id; matches the `provider` column on public.payout_accounts. */
  id: ProviderId;
  /** Human-facing label, e.g. "Stripe". */
  label: string;
  /** Whether this rail is live. Disabled rails are placeholders only — no API
   *  code exists yet (PayPal is enabled:false at beta). */
  enabled: boolean;
  /** Connect-account type stored on the row (Stripe Express, etc.). */
  accountType: string;
  /** Fixed processing-fee schedule for this rail, surfaced in disclosures. */
  processingFeeLabel: string;
  /** Relative API entry points for this rail. */
  routes: {
    /** POST to begin/resume onboarding; returns a hosted redirect URL. */
    onboard: string;
    /** GET source-of-truth account status. */
    status: string;
  };
  /** UI copy for the Revenue Recovery / Connect card. */
  copy: {
    cardTitle: string;
    cardSubtitle: string;
    connectCta: string;
    finishCta: string;
    continueCta: string;
  };
  /** Format a provider account id for display (e.g. mask/abbreviate). */
  formatAccountId: (accountId: string) => string;
  /** Rev-share + processing-fee disclosure. `ratePct` is the plan-derived
   *  percentage string (e.g. "12") or null when unresolved, so the copy never
   *  shows a hardcoded rate. */
  feeDisclosure: (ratePct: string | null) => string;
}

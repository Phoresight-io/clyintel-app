import type { PaymentProvider } from "./types";

// Stripe Connect (Express) — the only fully-implemented payout rail at beta.
// Onboarding/status routes live under /api/connect; the disclosure pairs the
// plan-derived rev-share rate with Stripe's fixed processing fee.

const PROCESSING_FEE_LABEL = "2.9% + $0.30";

export const stripeProvider: PaymentProvider = {
  id: "stripe",
  label: "Stripe",
  enabled: true,
  accountType: "express",
  processingFeeLabel: PROCESSING_FEE_LABEL,
  routes: {
    onboard: "/api/connect/onboard",
    status: "/api/connect/status",
  },
  copy: {
    cardTitle: "Revenue Recovery",
    cardSubtitle: "Connect Stripe so Clyintel can recover overdue payments on your behalf.",
    connectCta: "Connect Stripe to enable Revenue Recovery",
    finishCta: "Finish setup",
    continueCta: "Continue setup",
  },
  // Stripe account ids (acct_…) are shown as-is.
  formatAccountId: (accountId) => accountId,
  feeDisclosure: (ratePct) =>
    ratePct
      ? `Clyintel charges ${ratePct}% per recovered payment, plus Stripe processing fees (${PROCESSING_FEE_LABEL}).`
      : `Clyintel charges a revenue-share fee per recovered payment, plus Stripe processing fees (${PROCESSING_FEE_LABEL}).`,
};

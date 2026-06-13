import type { PaymentProvider } from "./types";

// PayPal payout rail — STUB ONLY. There is deliberately no PayPal API
// integration yet; this placeholder exists so the data model (payout_accounts
// allows provider='paypal') and the registry are ready for a future drop-in.
// `enabled: false` keeps it out of live routing/onboarding and lets the UI show
// it as "coming soon" without inventing chrome the prototype doesn't specify.

export const paypalProvider: PaymentProvider = {
  id: "paypal",
  label: "PayPal",
  enabled: false,
  accountType: "paypal_merchant",
  processingFeeLabel: "—",
  routes: {
    // No routes implemented while disabled.
    onboard: "",
    status: "",
  },
  copy: {
    cardTitle: "Revenue Recovery (PayPal)",
    cardSubtitle: "PayPal payouts are coming soon.",
    connectCta: "Coming soon",
    finishCta: "Coming soon",
    continueCta: "Coming soon",
  },
  formatAccountId: (accountId) => accountId,
  feeDisclosure: () => "PayPal revenue recovery is coming soon.",
};

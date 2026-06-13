// Payout-provider registry. Recovery/routing logic and the ConnectCard read
// onboarding entry points, fee disclosure, and copy through this registry rather
// than via inline Stripe literals, so adding PayPal later is a drop-in.

import type { PaymentProvider, ProviderId } from "./types";
import { stripeProvider } from "./stripe";
import { paypalProvider } from "./paypal";

export type { PaymentProvider, ProviderId } from "./types";

export const PAYMENT_PROVIDERS: Record<ProviderId, PaymentProvider> = {
  stripe: stripeProvider,
  paypal: paypalProvider,
};

/** The default payout rail at beta. */
export const DEFAULT_PROVIDER_ID: ProviderId = "stripe";

/** Look up a provider config by id. */
export function getProvider(id: ProviderId): PaymentProvider {
  return PAYMENT_PROVIDERS[id];
}

/** Live (enabled) providers — drives any provider affordance in the UI. At beta
 *  this is Stripe only; PayPal stays invisible until its stub is implemented. */
export function enabledProviders(): PaymentProvider[] {
  return Object.values(PAYMENT_PROVIDERS).filter((p) => p.enabled);
}

// Minimal Stripe REST client.
//
// We deliberately avoid the `stripe` npm package (product rule: "do not add
// packages without approval") and talk to the Stripe API directly via `fetch`,
// the same convention the webhook route established. Server-only — never import
// from client components, as it reads STRIPE_SECRET_KEY.

const STRIPE_API = "https://api.stripe.com/v1";

function getKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return key;
}

// Flatten nested objects/arrays into Stripe's bracketed form-encoding, e.g.
// { line_items: [{ price: "x" }] } → "line_items[0][price]=x".
function encode(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${prefix}[${k}]`, v);
      }
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return pairs.join("&");
}

async function stripeRequest<T>(
  path: string,
  method: "GET" | "POST",
  params?: Record<string, unknown>
): Promise<T> {
  const base = `${STRIPE_API}${path}`;
  const url = method === "GET" && params ? `${base}?${encode(params)}` : base;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (method === "POST" && params) init.body = encode(params);

  const res = await fetch(url, init);
  const json = (await res.json()) as { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(json?.error?.message ?? `Stripe request failed (${res.status})`);
  }
  return json as T;
}

// Create a Stripe customer for a subscriber. `subscriber_id` is stored in
// metadata so the customer can be traced back without relying on email.
export async function createCustomer(email: string, subscriberId: string): Promise<string> {
  const customer = await stripeRequest<{ id: string }>("/customers", "POST", {
    email,
    metadata: { subscriber_id: subscriberId },
  });
  return customer.id;
}

// Resolve a product's default price id (or null if none is set).
export async function getProductDefaultPrice(productId: string): Promise<string | null> {
  const product = await stripeRequest<{ default_price: string | null }>(
    `/products/${productId}`,
    "GET"
  );
  return product.default_price ?? null;
}

// Create a subscription-mode Checkout Session and return its hosted URL.
export async function createCheckoutSession(opts: {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  subscriberId: string;
}): Promise<string> {
  const session = await stripeRequest<{ url: string | null }>("/checkout/sessions", "POST", {
    mode: "subscription",
    customer: opts.customerId,
    line_items: [{ price: opts.priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.subscriberId,
    subscription_data: { metadata: { subscriber_id: opts.subscriberId } },
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  return session.url;
}

// ── Stripe Connect (Express) ────────────────────────────────────────────────
// Revenue-share onboarding: each subscriber connects their own Express account
// so recovered funds settle to them and Clyintel takes its share via destination
// charges (built in later prompts). These helpers cover account creation, the
// hosted onboarding link, and a status refresh.

// Shape of the subset of the Stripe Account object we rely on.
export interface StripeConnectAccount {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements?: { disabled_reason?: string | null } | null;
}

// Create an Express connected account for a subscriber. `transfers` is required
// in addition to `card_payments` because revenue-share uses destination charges,
// which move funds to the connected account. `subscriber_id` is stored in
// metadata so webhooks (Prompt 4) can map the account back without a lookup.
export async function createExpressAccount(
  email: string,
  subscriberId: string
): Promise<StripeConnectAccount> {
  return stripeRequest<StripeConnectAccount>("/accounts", "POST", {
    type: "express",
    email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { subscriber_id: subscriberId },
  });
}

// Create an `account_onboarding` Account Link and return its hosted URL. Account
// Links are single-use and short-lived; refresh_url should point back at the
// route that mints them so an expired/visited link regenerates seamlessly.
export async function createAccountOnboardingLink(opts: {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<string> {
  const link = await stripeRequest<{ url: string | null }>("/account_links", "POST", {
    account: opts.accountId,
    type: "account_onboarding",
    return_url: opts.returnUrl,
    refresh_url: opts.refreshUrl,
  });
  if (!link.url) throw new Error("Stripe did not return an Account Link URL");
  return link.url;
}

// Retrieve the current state of a connected account (source of truth for the
// status route — never trust the onboarding return_url redirect alone).
export async function retrieveAccount(accountId: string): Promise<StripeConnectAccount> {
  return stripeRequest<StripeConnectAccount>(`/accounts/${accountId}`, "GET");
}

// ── Recovery payment links ──────────────────────────────────────────────────
// Create a one-time Checkout Session (mode=payment) on the platform account with
// a DESTINATION CHARGE to the subscriber's Express account. The session is minted
// at click-time so the amount always reflects the live balance (live-resolve).
//
// application_fee_amount = round(balance × plan_rev_share_rate) — billed on the
// gross charge amount in the same currency minor units.
//
// Metadata is placed on both the Session and the PaymentIntent so the Prompt 4
// webhook can reconcile the payment back to the recovery_link regardless of which
// object the event carries.

export interface RecoveryCheckoutOpts {
  token: string;
  invoiceId: string;
  subscriberId: string;
  providerAccountId: string;   // connected Express account (acct_…)
  revShareRate: number;        // fraction, e.g. 0.12 for 12 %
  balanceCents: number;        // authoritative remaining balance in minor units
  currency: string;            // ISO 4217 lowercase, e.g. "usd"
  invoiceNumber: string | null;
  successUrl: string;
  cancelUrl: string;
}

export async function createRecoveryCheckoutSession(
  opts: RecoveryCheckoutOpts
): Promise<string> {
  const fee = Math.round(opts.balanceCents * opts.revShareRate);
  const lineItemName = opts.invoiceNumber
    ? `Invoice #${opts.invoiceNumber} — outstanding balance`
    : "Outstanding invoice balance";

  const sessionMeta = {
    recovery_link_token: opts.token,
    invoice_id: opts.invoiceId,
    subscriber_id: opts.subscriberId,
  };

  const session = await stripeRequest<{ url: string | null }>("/checkout/sessions", "POST", {
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: opts.currency,
          unit_amount: opts.balanceCents,
          product_data: {
            name: lineItemName,
          },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      transfer_data: {
        destination: opts.providerAccountId,
      },
      application_fee_amount: fee,
      metadata: sessionMeta,
    },
    metadata: sessionMeta,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });

  if (!session.url) throw new Error("Stripe did not return a Checkout Session URL");
  return session.url;
}

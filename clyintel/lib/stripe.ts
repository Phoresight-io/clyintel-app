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

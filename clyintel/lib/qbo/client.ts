import { qboApiBaseUrl } from "./constants";

// Thin QBO Accounting API read client: exactly two single-entity GETs
// (Payment, Invoice). The access token is INJECTED by the caller (the adapter,
// which obtains it via getValidAccessToken) — this client does NOT import
// tokens.ts, refresh, or read connected_accounts, so it stays a trivially
// testable pure HTTP client. No retries, no caching, no rate-limit logic.
//
// On a non-2xx it THROWS (never returns null / swallows): the worker's
// try/catch turns a thrown error into a failed/retry on the webhook_events row.
// Error messages carry the status + entity/id but NEVER the access token.

// --- Narrow return types (only the fields the adapter needs downstream) ---

export interface QboLinkedTxn {
  TxnId: string;
  TxnType: string;
}

export interface QboPaymentLine {
  LinkedTxn?: QboLinkedTxn[];
}

export interface QboPayment {
  Id: string;
  TotalAmt: number;
  TxnDate: string;
  /** Payment lines; each may link invoices via LinkedTxn (TxnType 'Invoice'). */
  Line?: QboPaymentLine[];
  /** Escape hatch: the unwrapped QBO entity, for any field not modeled above. */
  raw?: unknown;
}

export interface QboInvoice {
  Id: string;
  TotalAmt: number;
  DueDate?: string;
  Balance?: number;
  /** Escape hatch: the unwrapped QBO entity, for any field not modeled above. */
  raw?: unknown;
}

/**
 * Extract the linked Invoice ids from a QBO Payment. In QBO a Payment links the
 * invoices it settles via `Line[].LinkedTxn[]`, where `LinkedTxn.TxnType` is
 * `'Invoice'` and `LinkedTxn.TxnId` is the invoice id. Provided so the adapter
 * doesn't have to re-walk the QBO shape.
 */
export function linkedInvoiceIds(payment: QboPayment): string[] {
  const ids: string[] = [];
  for (const line of payment.Line ?? []) {
    for (const link of line.LinkedTxn ?? []) {
      if (link.TxnType === "Invoice" && link.TxnId) {
        ids.push(link.TxnId);
      }
    }
  }
  return ids;
}

// --- HTTP core ---

/**
 * GET a single QBO entity and unwrap the `{ "<Wrapper>": {...} }` envelope QBO
 * uses for single-entity reads. Throws on non-2xx (auth-flavored on 401).
 */
async function qboGetEntity<T>(
  realmId: string,
  entityPath: "payment" | "invoice",
  wrapperKey: "Payment" | "Invoice",
  entityId: string,
  accessToken: string,
): Promise<T> {
  const url = `${qboApiBaseUrl()}/v3/company/${realmId}/${entityPath}/${entityId}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    // NEVER include the access token in the thrown message.
    if (res.status === 401) {
      throw new Error(
        `QBO ${wrapperKey} ${entityId} fetch failed: 401 Unauthorized — ` +
          `access token rejected (may be revoked or expired; the caller must ` +
          `refresh via getValidAccessToken)`,
      );
    }
    throw new Error(`QBO ${wrapperKey} ${entityId} fetch failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  const inner = body[wrapperKey];
  if (inner == null || typeof inner !== "object") {
    throw new Error(
      `QBO ${wrapperKey} ${entityId} fetch returned no "${wrapperKey}" entity`,
    );
  }

  return { ...(inner as object), raw: inner } as T;
}

/** GET {base}/v3/company/{realmId}/payment/{paymentId} → unwrapped Payment. */
export async function getPayment(
  realmId: string,
  paymentId: string,
  accessToken: string,
): Promise<QboPayment> {
  return qboGetEntity<QboPayment>(realmId, "payment", "Payment", paymentId, accessToken);
}

/** GET {base}/v3/company/{realmId}/invoice/{invoiceId} → unwrapped Invoice. */
export async function getInvoice(
  realmId: string,
  invoiceId: string,
  accessToken: string,
): Promise<QboInvoice> {
  return qboGetEntity<QboInvoice>(realmId, "invoice", "Invoice", invoiceId, accessToken);
}

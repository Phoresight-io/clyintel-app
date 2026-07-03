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

// ===========================================================================
// LIST / QUERY path (appended) — the QBO query API, used by the sync layer to
// pull the full Customer / Invoice lists. Separate from the single-entity GET
// path above (getPayment/getInvoice/qboGetEntity) because the query API uses a
// different envelope ({ QueryResponse: { <Entity>: [...] } }) and returns
// arrays. Everything above this line is frozen (the D2 payment path depends on
// it) and is NOT modified here. Still a dumb transport: no Supabase, no upsert,
// no filtering, no cents conversion — the sync layer decides what to keep.
// ===========================================================================

// --- Narrow list return types (distinct from the frozen QboInvoice on purpose) ---

export interface QboCustomerListItem {
  Id: string;
  DisplayName?: string;
  Active?: boolean;
  raw?: unknown;
}

export interface QboInvoiceListItem {
  Id: string;
  TotalAmt: number;
  DueDate?: string;
  Balance?: number;
  DocNumber?: string;
  CustomerRef?: { value: string; name?: string };
  raw?: unknown;
}

/**
 * Run a QBO SQL-ish query and unwrap the `{ QueryResponse: { <Entity>: [...] } }`
 * envelope the query API uses (different from the single-entity GET envelope, so
 * this is a separate helper from qboGetEntity). Throws on non-2xx
 * (auth-flavored on 401). QBO omits the entity key entirely when there are zero
 * matching rows, so a missing key is treated as an empty list, not an error.
 */
async function qboQuery<T>(
  realmId: string,
  query: string,
  entityKey: "Invoice" | "Customer",
  accessToken: string,
): Promise<T[]> {
  const url = `${qboApiBaseUrl()}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`;

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
        `QBO ${entityKey} query failed: 401 Unauthorized — ` +
          `access token rejected (may be revoked or expired; the caller must ` +
          `refresh via getValidAccessToken)`,
      );
    }
    throw new Error(`QBO ${entityKey} query failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as { QueryResponse?: Record<string, unknown> };
  const qr = body.QueryResponse ?? {};
  const rows = (qr[entityKey] as object[] | undefined) ?? [];
  return rows.map((item) => ({ ...item, raw: item })) as T[];
}

/** Safety cap: refuse to loop forever if a malformed response never shrinks a page. */
const QBO_MAX_PAGES = 100;
/** QBO caps a query page at 1000 rows; a short page means we've reached the end. */
const QBO_PAGE_SIZE = 1000;

/**
 * Fetch every Customer for the realm, paging through the QBO query API. No
 * server-side filtering — returns the full list; the sync layer decides what to
 * keep.
 */
export async function listCustomers(
  realmId: string,
  accessToken: string,
): Promise<QboCustomerListItem[]> {
  const all: QboCustomerListItem[] = [];
  let pos = 1;
  for (let page = 0; page < QBO_MAX_PAGES; page++) {
    const query = `SELECT * FROM Customer STARTPOSITION ${pos} MAXRESULTS ${QBO_PAGE_SIZE}`;
    const rows = await qboQuery<QboCustomerListItem>(realmId, query, "Customer", accessToken);
    all.push(...rows);
    if (rows.length < QBO_PAGE_SIZE) return all;
    pos += rows.length;
  }
  throw new Error("QBO Customer query exceeded pagination cap");
}

/**
 * Fetch every Invoice for the realm, paging through the QBO query API. No
 * server-side filtering — returns the full list; the sync layer decides what to
 * keep.
 */
export async function listInvoices(
  realmId: string,
  accessToken: string,
): Promise<QboInvoiceListItem[]> {
  const all: QboInvoiceListItem[] = [];
  let pos = 1;
  for (let page = 0; page < QBO_MAX_PAGES; page++) {
    const query = `SELECT * FROM Invoice STARTPOSITION ${pos} MAXRESULTS ${QBO_PAGE_SIZE}`;
    const rows = await qboQuery<QboInvoiceListItem>(realmId, query, "Invoice", accessToken);
    all.push(...rows);
    if (rows.length < QBO_PAGE_SIZE) return all;
    pos += rows.length;
  }
  throw new Error("QBO Invoice query exceeded pagination cap");
}

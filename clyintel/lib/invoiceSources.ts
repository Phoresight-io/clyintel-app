// Invoice-source provider registry — the SINGLE SOURCE OF TRUTH for the
// accounting/invoicing platforms ClyIntel can pull invoices from. Consumed by
// BOTH the Integrations (connections) screen and the Add-Client picker so the
// two never drift. Adding a new invoice source must be a DATA change in this
// file only — no new branching in the screens or the /api/sources route.
//
// NOTE: This is deliberately SEPARATE from lib/providers/ (the payout-rail
// registry: Stripe Connect / PayPal). That registry describes where recovered
// money is paid OUT; this one describes where invoices are pulled IN. The
// `stripe` entry here is invoice-source Stripe (reading invoices), NOT Stripe
// Connect payouts — a different concern that lives in lib/providers/.

export type InvoiceSourceId = "quickbooks" | "freshbooks" | "stripe" | "xero";

export interface InvoiceSource {
  /** Stable id. For sources backed by connected_accounts this matches the
   *  `provider` value on that row (quickbooks today). */
  id: InvoiceSourceId;
  /** Human-facing platform name. */
  name: string;
  /** Logo asset for the tile/card. `null` when we have no asset for a
   *  coming-soon source (do not invent assets). */
  logo: string | null;
  /** Label for the platform's account identifier. Generic "Company ID" across
   *  every source (NOT QBO-specific "Realm ID"). */
  idLabel: string;
  /** Relative GET endpoint that reports live connection status for this source,
   *  or `null` when the source has no backend yet (coming soon). */
  statusEndpoint: string | null;
  /** True while the source is displayed but not yet wired to a live sync path. */
  comingSoon: boolean;
}

// QuickBooks Online is the only live invoice source today. Its logo reuses the
// existing QuickBooks asset already used by the Add-Client tiles
// (ConnectionsScreen). The QuickBooksCard on the Integrations screen renders no
// logo image of its own (text heading only), so this CDN mark is the single QB
// logo asset the app currently ships.
const QUICKBOOKS_LOGO = "https://cdn.simpleicons.org/quickbooks/FFFFFF";

export const INVOICE_SOURCES: Record<InvoiceSourceId, InvoiceSource> = {
  quickbooks: {
    id: "quickbooks",
    name: "QuickBooks Online",
    logo: QUICKBOOKS_LOGO,
    idLabel: "Company ID",
    statusEndpoint: "/api/qbo/status",
    comingSoon: false,
  },
  freshbooks: {
    id: "freshbooks",
    name: "FreshBooks",
    logo: null,
    idLabel: "Company ID",
    statusEndpoint: null,
    comingSoon: true,
  },
  stripe: {
    id: "stripe",
    name: "Stripe",
    logo: null,
    idLabel: "Company ID",
    statusEndpoint: null,
    comingSoon: true,
  },
  xero: {
    id: "xero",
    name: "Xero",
    logo: null,
    idLabel: "Company ID",
    statusEndpoint: null,
    comingSoon: true,
  },
};

/** Every invoice source, registry order preserved. */
export const INVOICE_SOURCE_LIST: InvoiceSource[] = Object.values(INVOICE_SOURCES);

/** Ids of every invoice source. This is the set /api/sources scopes to — the
 *  registry defines it, so no route hardcodes a QBO-only filter. */
export const INVOICE_SOURCE_IDS = Object.keys(INVOICE_SOURCES) as InvoiceSourceId[];

/** Live (not coming-soon) invoice sources — QuickBooks only at present. */
export const LIVE_INVOICE_SOURCES: InvoiceSource[] = INVOICE_SOURCE_LIST.filter(
  (s) => !s.comingSoon,
);

/** Type guard: is this arbitrary string a known invoice-source id? Used to keep
 *  the registry the source of truth when filtering connected_accounts rows. */
export function isInvoiceSourceId(value: string): value is InvoiceSourceId {
  return Object.prototype.hasOwnProperty.call(INVOICE_SOURCES, value);
}

/** Look up a source config by id (undefined if unknown). */
export function getInvoiceSource(id: string): InvoiceSource | undefined {
  return isInvoiceSourceId(id) ? INVOICE_SOURCES[id] : undefined;
}

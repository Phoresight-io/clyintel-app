import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase-server";
import { isInvoiceSourceId, type InvoiceSourceId } from "@/lib/invoiceSources";
import type { Database } from "@/types/supabase";

// The subset of connected_accounts columns this route selects.
type ConnectedAccountRow = Pick<
  Database["public"]["Tables"]["connected_accounts"]["Row"],
  "provider" | "external_id" | "meta" | "connected_at" | "updated_at" | "disconnected_at"
>;

// Listing route for the calling subscriber's invoice-source connections. Backs
// the Integrations screen (and, later, the Add-Client picker) so a tile can show
// one of three states per invoice source:
//
//   connected                    → a row exists AND external_id IS NOT NULL
//   disconnected (was connected) → a row exists, external_id IS NULL, and
//                                  disconnected_at IS NOT NULL. We surface
//                                  meta.disconnected_external_id so the tile can
//                                  still render a masked Company ID.
//   never-connected              → NO ROW for that provider → it is simply ABSENT
//                                  from `sources` (not returned as a row).
//
// UNLIKE /api/qbo/status, this route returns the FULL, UNMASKED external_id
// (Company ID). The Company ID is not a secret; the client masks it in JS and
// the eye-toggle reveals it. This is deliberate — do not copy status's
// server-side masking here.
//
// Auth/scoping mirrors GET /api/qbo/status: cookie-bound createSupabaseServer →
// auth.getUser, then a cookie-bound read whose RLS scopes rows to the caller's
// own subscriber_id. No service-role client, no cross-subscriber reach.
//
// The set of invoice-source providers comes from the registry
// (INVOICE_SOURCES), NOT a hardcoded QBO filter: we read the caller's
// connected_accounts rows and keep only those whose provider is a known
// invoice-source id. (We filter in JS rather than with .in(provider, [...])
// because the DB integration_provider enum does not contain every registry id,
// e.g. freshbooks/xero, so an enum-typed .in() would reject them.)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SourceState = "connected" | "disconnected";

interface SourceRow {
  provider: InvoiceSourceId;
  state: SourceState;
  /** Full, UNMASKED Company ID when connected; null when disconnected. */
  external_id: string | null;
  /** The prior Company ID preserved on soft-void, so a disconnected tile can
   *  still show a (client-masked) id. Null when connected or never set. */
  disconnected_external_id: string | null;
  connected_at: string;
  updated_at: string;
  disconnected_at: string | null;
}

export async function GET() {
  const authClient = await createSupabaseServer();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Cookie-bound read — RLS scopes to the caller's own connected_accounts rows.
  const { data: rows, error: lookupError } = await authClient
    .from("connected_accounts")
    .select("provider, external_id, meta, connected_at, updated_at, disconnected_at")
    .eq("subscriber_id", user.id);

  if (lookupError) {
    console.error("api/sources: connected_accounts lookup failed", lookupError);
    return NextResponse.json({ error: "Could not load invoice sources" }, { status: 500 });
  }

  const sources: SourceRow[] = ((rows ?? []) as ConnectedAccountRow[])
    // Registry is the source of truth for which providers are invoice sources.
    .filter((row) => isInvoiceSourceId(row.provider))
    // A row with external_id NULL and no disconnected_at was never really a
    // live connection (nothing to surface) — treat it as never-connected/absent.
    .filter((row) => row.external_id !== null || row.disconnected_at !== null)
    .map((row) => {
      const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<
        string,
        unknown
      >;
      const disconnectedExternalId =
        typeof meta.disconnected_external_id === "string"
          ? meta.disconnected_external_id
          : null;

      const connected = row.external_id !== null;

      return {
        provider: row.provider as InvoiceSourceId,
        state: connected ? "connected" : "disconnected",
        external_id: row.external_id, // full/unmasked; client masks in JS
        disconnected_external_id: connected ? null : disconnectedExternalId,
        connected_at: row.connected_at,
        updated_at: row.updated_at,
        disconnected_at: row.disconnected_at,
      } satisfies SourceRow;
    });

  return NextResponse.json({ sources });
}

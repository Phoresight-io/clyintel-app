/**
 * CaptureEvent — the platform-agnostic shape every capture source normalizes
 * into before the detection core touches it.
 *
 * Units are DOLLARS, matching computeRevShareFee and the rev_share_ledger
 * numeric columns. Sources that store cents (e.g. the live `invoices` /
 * `recovery_attempts` `*_cents` bigint columns) MUST convert at the adapter
 * boundary — the core stays in the engine's native unit and never sees cents.
 *
 * The adapter (Phase 2) owns producing this, including resolving
 * `invoiceFaceValue` from the platform. The core never knows how any field
 * was fetched.
 */
export interface CaptureEvent {
  /** Registry slug, validated against capture_sources.id (e.g. 'qbo'). */
  source: string;
  /** Platform's payment id. Idempotency key — half of (source, sourcePaymentId). */
  sourcePaymentId: string;
  /** Platform's invoice id. Written to ledger.source_invoice_id AND invoice_ref. */
  sourceInvoiceId: string;
  /** Full invoice face value (DOLLARS), resolved by adapter, frozen onto the row. */
  invoiceFaceValue: number;
  /** This captured payment's amount (DOLLARS). Fee = rate × this. */
  dollarsRecovered: number;
  /** ISO 8601 — when the payment cleared. Drives captured_at + cycle_close. */
  capturedAt: string;
  /** External account identity from event metadata. Maps to a subscriber. */
  connectedAccountRef: string;
}

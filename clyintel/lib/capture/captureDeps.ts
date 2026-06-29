/**
 * CaptureDeps — the dependency seam the detection core depends on.
 *
 * Types only — no implementation, no DB calls, no detection logic. The live
 * adapter (Phase 2) implements this against Supabase / the platform; tests
 * mock it. The core never knows how any field was fetched.
 */

/**
 * The frozen row shape written to rev_share_ledger. Every value is captured at
 * detection time — face value, band, rate, and fee are snapshotted so the row
 * never drifts if bands are re-calibrated later.
 */
export interface LedgerInsert {
  subscriber_id: string;
  source: string;
  source_payment_id: string;
  source_invoice_id: string;
  invoice_ref: string;
  invoice_face_value: number;
  dollars_recovered: number;
  band: string;
  rate: number;
  fee_amount: number;
  captured_at: string;   // ISO 8601 timestamp
  cycle_close: string;   // ISO date (YYYY-MM-DD)
  engine_version: string;
}

export interface CaptureDeps {
  /**
   * Resolve a connectedAccountRef to a subscriber.
   * Canonical join: connected_accounts.external_id → subscriber_id.
   * Legacy subscribers.qbo_realm_id is intentionally NOT used.
   * Ambiguous (>1 match) and not-found are distinct typed rejections —
   * there is no DB uniqueness constraint on external_id today, so the
   * core must defend against >1 rather than assume uniqueness.
   */
  resolveSubscriber(ref: string): Promise<
    | { ok: true; subscriberId: string }
    | { ok: false; reason: 'subscriber_not_found' | 'ambiguous_subscriber' }
  >;

  /** Look up a capture source by registry slug. null = unknown source. */
  getSource(slug: string): Promise<{ id: string; active: boolean } | null>;

  /**
   * Attribution facts for an invoice under a subscriber.
   * outreachSent = ≥1 recovery_attempts (sent_at not null)
   *                OR communications (direction='outbound', sent_at not null).
   * Past-due is NOT read here — it comes from event.invoicePastDue (adapter-resolved).
   */
  getInvoiceAttribution(subscriberId: string, sourceInvoiceId: string): Promise<{
    found: boolean;
    outreachSent: boolean;
  }>;

  /** Whether the subscriber's account is currently active. */
  isSubscriberActive(subscriberId: string): Promise<boolean>;

  /**
   * Idempotent insert against the unique (source, source_payment_id) index.
   * inserted=true with the new id, or inserted=false with the existing row's id
   * when the same payment was already captured.
   */
  insertLedgerRow(row: LedgerInsert): Promise<
    | { inserted: true;  id: string }
    | { inserted: false; existingId: string }
  >;
}

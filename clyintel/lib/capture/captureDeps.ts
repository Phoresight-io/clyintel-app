/**
 * CaptureDeps — the dependency seam the detection core depends on.
 *
 * This file carries ONLY the subscriber-resolution portion of the interface;
 * the rest of the deps land in Deliverable 3. No implementation, no DB calls,
 * and no detection logic live here — types only.
 */
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
}

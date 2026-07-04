import { describe, it, expect, vi, beforeEach } from "vitest";

// Alias-less vitest: mock the seam via relative specifiers (same convention as
// captureDepsLive.test.ts / worker.test.ts).
vi.mock("../supabase", () => ({ getSupabase: vi.fn() }));
vi.mock("../capture/captureDepsLive", () => ({ createLiveCaptureDeps: vi.fn(() => ({})) }));
vi.mock("../capture/processCaptureEvent", () => ({ processCaptureEvent: vi.fn() }));
// resolveInvoicePastDue is left REAL (pure, exported) so the event's past-due
// flag is exercised end-to-end. Its module (../qbo/captureAdapter) transitively
// imports ../qbo/tokens + ../qbo/client, which use the @/ alias vitest doesn't
// resolve — stub those leaf modules so the adapter (and the real, pure
// resolveInvoicePastDue) loads. They're unused on this code path.
vi.mock("../qbo/tokens", () => ({}));
vi.mock("../qbo/client", () => ({}));

import { handleRecoveryCheckoutCompleted } from "./handleCheckoutCompleted";
import { getSupabase } from "../supabase";
import { processCaptureEvent } from "../capture/processCaptureEvent";

type Result = { data: unknown; error: unknown };

// Supabase stub: FIFO per table (as in captureDepsLive.test.ts), plus it records
// the payload handed to recovery_links.update so we can assert the flip.
function makeSupabase(queues: Record<string, Result[]>, captured: { update?: Record<string, unknown> }) {
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ["select", "eq", "not", "limit", "maybeSingle", "single", "insert"]) {
      builder[m] = vi.fn(chain);
    }
    builder.update = vi.fn((payload: Record<string, unknown>) => {
      if (table === "recovery_links") captured.update = payload;
      return builder;
    });
    builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => {
      const q = queues[table];
      if (!q || q.length === 0) {
        return Promise.reject(new Error(`no queued result for table ${table}`)).then(onF, onR);
      }
      return Promise.resolve(q.shift() as Result).then(onF, onR);
    };
    return builder;
  });
  return { from };
}

function withSupabase(queues: Record<string, Result[]>, captured: { update?: Record<string, unknown> }) {
  vi.mocked(getSupabase).mockReturnValue(makeSupabase(queues, captured) as never);
}

// event.created = 2026-06-28T00:00:00Z (unix seconds) → deterministic capturedAt.
const EVENT_CREATED = Math.floor(Date.parse("2026-06-28T00:00:00.000Z") / 1000);

// A completed recovery session (only the fields the handler reads).
const SESSION = {
  id: "cs_test_1",
  amount_total: 390000,
  payment_intent: "pi_test_1",
  metadata: { recovery_link_token: "tok_abc" },
};

beforeEach(() => vi.clearAllMocks());

describe("handleRecoveryCheckoutCompleted", () => {
  it("completion: flips link to paid, records settlement, builds a stripe_recovery CaptureEvent, returns 200 on a gated rejection (no throw)", async () => {
    const captured: { update?: Record<string, unknown> } = {};
    withSupabase(
      {
        recovery_links: [
          // (1) resolve by session id
          { data: { id: "rl_1", invoice_id: "inv_uuid", subscriber_id: "sub_1", link_status: "active" }, error: null },
          // (2) the flip update
          { data: null, error: null },
        ],
        // invoice by id: QBO-sourced, past-due (due_date < capturedAt)
        invoices: [{ data: { external_id: "145", amount_cents: 390000, due_date: "2026-05-01" }, error: null }],
        // exactly one QBO connection → unambiguous realm
        connected_accounts: [{ data: [{ external_id: "realm_9130" }], error: null }],
      },
      captured,
    );
    // Engine gates it out (no outreach) — a VALID outcome; handler must not throw.
    vi.mocked(processCaptureEvent).mockResolvedValue({ status: "no_fee", reason: "no_outreach" } as never);

    await expect(
      handleRecoveryCheckoutCompleted(SESSION, "evt_1", EVENT_CREATED),
    ).resolves.toBeUndefined();

    // Link flipped to paid with settlement = amount_total.
    expect(captured.update).toMatchObject({ link_status: "paid", settlement_amount_cents: 390000 });

    // Engine invoked exactly once with a correctly-shaped stripe_recovery event.
    expect(processCaptureEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(processCaptureEvent).mock.calls[0][0];
    expect(event).toMatchObject({
      source: "stripe_recovery",
      sourcePaymentId: "pi_test_1", // = session.payment_intent
      sourceInvoiceId: "145", // = invoices.external_id (QBO txnId)
      connectedAccountRef: "realm_9130", // = subscriber's QBO realm
      invoiceFaceValue: 3900, // amount_cents / 100
      dollarsRecovered: 3900, // amount_total / 100
      invoicePastDue: true, // due_date 2026-05-01 < capturedAt 2026-06-28
      capturedAt: "2026-06-28T00:00:00.000Z",
    });
  });

  it("idempotency: duplicate delivery on an already-paid link returns early and calls processCaptureEvent ZERO times", async () => {
    const captured: { update?: Record<string, unknown> } = {};
    withSupabase(
      {
        recovery_links: [
          { data: { id: "rl_1", invoice_id: "inv_uuid", subscriber_id: "sub_1", link_status: "paid" }, error: null },
        ],
      },
      captured,
    );

    await expect(
      handleRecoveryCheckoutCompleted(SESSION, "evt_dup", EVENT_CREATED),
    ).resolves.toBeUndefined();

    // Primary duplicate-delivery guard: no second capture, no re-flip.
    expect(processCaptureEvent).toHaveBeenCalledTimes(0);
    expect(captured.update).toBeUndefined();
  });

  it("no matching recovery_links row (subscription/other session) → ignore, no flip, no capture", async () => {
    const captured: { update?: Record<string, unknown> } = {};
    withSupabase(
      {
        // session-id lookup misses; token fallback also misses.
        recovery_links: [
          { data: null, error: null },
          { data: null, error: null },
        ],
      },
      captured,
    );

    await expect(
      handleRecoveryCheckoutCompleted(SESSION, "evt_other", EVENT_CREATED),
    ).resolves.toBeUndefined();

    expect(processCaptureEvent).toHaveBeenCalledTimes(0);
    expect(captured.update).toBeUndefined();
  });

  it("0 or >1 QBO connections → link still flips to paid, but capture is skipped (no processCaptureEvent)", async () => {
    const captured: { update?: Record<string, unknown> } = {};
    withSupabase(
      {
        recovery_links: [
          { data: { id: "rl_1", invoice_id: "inv_uuid", subscriber_id: "sub_1", link_status: "active" }, error: null },
          { data: null, error: null }, // flip
        ],
        invoices: [{ data: { external_id: "145", amount_cents: 390000, due_date: "2026-05-01" }, error: null }],
        connected_accounts: [{ data: [{ external_id: "realm_a" }, { external_id: "realm_b" }], error: null }],
      },
      captured,
    );

    await expect(
      handleRecoveryCheckoutCompleted(SESSION, "evt_ambig", EVENT_CREATED),
    ).resolves.toBeUndefined();

    // Link is paid (payment happened) but the ambiguous realm blocks attribution.
    expect(captured.update).toMatchObject({ link_status: "paid", settlement_amount_cents: 390000 });
    expect(processCaptureEvent).toHaveBeenCalledTimes(0);
  });
});

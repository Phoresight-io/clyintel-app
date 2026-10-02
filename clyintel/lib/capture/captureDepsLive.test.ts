import { describe, it, expect, vi, beforeEach } from "vitest";

// Alias-less vitest: mock the service client via its relative specifier.
vi.mock("../supabase", () => ({ getSupabase: vi.fn() }));

import { createLiveCaptureDeps, paymentTimesFor, type LiveCaptureDepsOptions } from "./captureDepsLive";
import { getSupabase } from "../supabase";
import type { LedgerInsert } from "./captureDeps";

type Result = { data: unknown; error: unknown };

/**
 * A minimal Supabase stub. `from(table)` returns a thenable query builder whose
 * chain methods (select/eq/not/limit/insert/maybeSingle/single) all return the
 * same builder; awaiting it yields the next queued Result for that table (FIFO),
 * so a method that queries the same table twice gets sequential results.
 */
function makeSupabase(queues: Record<string, Result[]>) {
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ["select", "eq", "not", "limit", "insert", "maybeSingle", "single"]) {
      builder[m] = vi.fn(chain);
    }
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

// Default payment context: a QBO payment dated 2026-09-23 (TxnDate → 00:00Z),
// recorded in QuickBooks (MetaData.CreateTime) at 2026-09-23 04:41:37Z.
const CREATE_TIME = "2026-09-22T21:41:37-07:00"; // == 2026-09-23T04:41:37Z
const QBO_PAYMENT: LiveCaptureDepsOptions = {
  paymentAt: "2026-09-23T00:00:00.000Z",
  source: "qbo",
  paymentRecordedAt: CREATE_TIME,
};
// Same payment with no usable CreateTime → TxnDate-only fallback.
const QBO_TXNDATE_ONLY: LiveCaptureDepsOptions = { paymentAt: "2026-09-23T00:00:00.000Z", source: "qbo" };

function depsWith(queues: Record<string, Result[]>, opts: LiveCaptureDepsOptions = QBO_PAYMENT) {
  const sb = makeSupabase(queues);
  vi.mocked(getSupabase).mockReturnValue(sb as never);
  return Object.assign(createLiveCaptureDeps(opts), { tablesRead: () => sb.from.mock.calls.map((c) => c[0]) });
}

beforeEach(() => vi.clearAllMocks());

describe("resolveSubscriber", () => {
  it("0 rows → subscriber_not_found", async () => {
    const deps = depsWith({ connected_accounts: [{ data: [], error: null }] });
    expect(await deps.resolveSubscriber("realm_x")).toEqual({
      ok: false,
      reason: "subscriber_not_found",
    });
  });

  it("2 rows → ambiguous_subscriber", async () => {
    const deps = depsWith({
      connected_accounts: [
        { data: [{ subscriber_id: "s1" }, { subscriber_id: "s2" }], error: null },
      ],
    });
    expect(await deps.resolveSubscriber("realm_x")).toEqual({
      ok: false,
      reason: "ambiguous_subscriber",
    });
  });

  it("1 row → ok with subscriberId", async () => {
    const deps = depsWith({ connected_accounts: [{ data: [{ subscriber_id: "s1" }], error: null }] });
    expect(await deps.resolveSubscriber("realm_1")).toEqual({ ok: true, subscriberId: "s1" });
  });
});

describe("getSource", () => {
  it("missing → null", async () => {
    const deps = depsWith({ capture_sources: [{ data: null, error: null }] });
    expect(await deps.getSource("qbo")).toBeNull();
  });

  it("present → { id, active }", async () => {
    const deps = depsWith({
      capture_sources: [{ data: { id: "qbo", active: true }, error: null }],
    });
    expect(await deps.getSource("qbo")).toEqual({ id: "qbo", active: true });
  });
});

describe("getInvoiceAttribution", () => {
  it("no local invoice → { found:false, outreachSent:false }", async () => {
    const deps = depsWith({ invoices: [{ data: [], error: null }] });
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({
      found: false,
      outreachSent: false,
    });
  });

  const invoiceWith = (outreach_started_at: string | null) => ({
    invoices: [{ data: [{ id: "inv_uuid", outreach_started_at }], error: null }],
  });

  it("null marker → outreachSent false (no fee)", async () => {
    const deps = depsWith(invoiceWith(null));
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: false });
  });

  it("qbo: marker 1s BEFORE CreateTime → outreachSent true (fee)", async () => {
    const deps = depsWith(invoiceWith("2026-09-23T04:41:36.000Z"));
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: true });
  });

  it("qbo: marker EQUAL to CreateTime → outreachSent false (equal is not before)", async () => {
    const deps = depsWith(invoiceWith("2026-09-23T04:41:37.000Z"));
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: false });
  });

  it("qbo: marker AFTER CreateTime but on the SAME day → outreachSent false (REVERSES #158, which billed this)", async () => {
    // Outreach sent at 21:47Z after the client paid (recorded 04:41Z). #158's
    // end-of-TxnDate-day cutoff counted it; the locked rule does not.
    const deps = depsWith(invoiceWith("2026-09-23T21:47:01.611Z"));
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: false });
  });

  it("qbo: marker on a later day → outreachSent false", async () => {
    const deps = depsWith(invoiceWith("2026-09-24T00:00:00.000Z"));
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: false });
  });

  it("qbo, no CreateTime: marker on an EARLIER UTC date than TxnDate → outreachSent true", async () => {
    const deps = depsWith(invoiceWith("2026-09-22T23:59:59.000Z"), QBO_TXNDATE_ONLY);
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: true });
  });

  it("qbo, no CreateTime: marker on the SAME UTC date as TxnDate → outreachSent false (REVERSES #158)", async () => {
    const deps = depsWith(invoiceWith("2026-09-23T00:00:01.000Z"), QBO_TXNDATE_ONLY);
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: false });
  });

  it("qbo, malformed CreateTime → falls back to TxnDate (earlier date → fee, same date → no fee)", async () => {
    const bad = { ...QBO_PAYMENT, paymentRecordedAt: "not-a-time" };
    expect(
      await depsWith(invoiceWith("2026-09-22T12:00:00.000Z"), bad).getInvoiceAttribution("s1", "130"),
    ).toEqual({ found: true, outreachSent: true });
    expect(
      await depsWith(invoiceWith("2026-09-23T01:00:00.000Z"), bad).getInvoiceAttribution("s1", "130"),
    ).toEqual({ found: true, outreachSent: false });
  });

  it("SIMULATION-only invoice (no marker) → no fee, and recovery_attempts / communications are never read", async () => {
    // A queued SIMULATION-style sent attempt + a would_send comm: the old gate
    // would have billed on these. The new gate reads only the invoice marker.
    const deps = depsWith({
      ...invoiceWith(null),
      recovery_attempts: [{ data: [{ id: "ra_sim" }], error: null }],
      communications: [{ data: [{ id: "c1" }], error: null }],
    });
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: false });
    expect(deps.tablesRead()).toEqual(["invoices"]);
  });

  it("stripe_recovery uses the REAL timestamp (strict <): before → fee, equal or later the same day → no fee", async () => {
    const stripe = { paymentAt: "2026-09-23T15:00:00.000Z", source: "stripe_recovery" };
    expect(
      await depsWith(invoiceWith("2026-09-23T14:59:59.999Z"), stripe).getInvoiceAttribution("s1", "130"),
    ).toEqual({ found: true, outreachSent: true });
    expect(
      await depsWith(invoiceWith("2026-09-23T15:00:00.000Z"), stripe).getInvoiceAttribution("s1", "130"),
    ).toEqual({ found: true, outreachSent: false });
    expect(
      await depsWith(invoiceWith("2026-09-23T15:00:00.001Z"), stripe).getInvoiceAttribution("s1", "130"),
    ).toEqual({ found: true, outreachSent: false });
  });

  it("stripe_recovery ignores a stray paymentRecordedAt (no QBO CreateTime on that rail)", async () => {
    const stripe = { paymentAt: "2026-09-23T15:00:00.000Z", source: "stripe_recovery", paymentRecordedAt: "2030-01-01T00:00:00Z" };
    expect(
      await depsWith(invoiceWith("2026-09-23T16:00:00.000Z"), stripe).getInvoiceAttribution("s1", "130"),
    ).toEqual({ found: true, outreachSent: false });
  });

  it("no usable payment time (unparseable paymentAt, no CreateTime) → outreachSent false (fail closed) and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = depsWith(invoiceWith("2026-09-10T04:52:22.947Z"), { paymentAt: "nope", source: "qbo" });
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("qbo: valid CreateTime but unparseable TxnDate → still decided by CreateTime", async () => {
    const deps = depsWith(invoiceWith("2026-09-23T04:41:36.000Z"), { ...QBO_PAYMENT, paymentAt: "nope" });
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({ found: true, outreachSent: true });
  });

  it(">1 local invoices → found:false and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = depsWith({
      invoices: [{ data: [{ id: "inv_a", outreach_started_at: null }, { id: "inv_b", outreach_started_at: null }], error: null }],
    });
    expect(await deps.getInvoiceAttribution("s1", "130")).toEqual({
      found: false,
      outreachSent: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/treating as not found/);
  });
});

describe("isSubscriberActive", () => {
  it("status 'active' → true", async () => {
    const deps = depsWith({ subscribers: [{ data: { subscription_status: "active" }, error: null }] });
    expect(await deps.isSubscriberActive("s1")).toBe(true);
  });

  it("other status → false", async () => {
    const deps = depsWith({ subscribers: [{ data: { subscription_status: "past_due" }, error: null }] });
    expect(await deps.isSubscriberActive("s1")).toBe(false);
  });

  it("missing subscriber → false", async () => {
    const deps = depsWith({ subscribers: [{ data: null, error: null }] });
    expect(await deps.isSubscriberActive("s1")).toBe(false);
  });
});

const LEDGER_ROW: LedgerInsert = {
  subscriber_id: "s1",
  source: "qbo",
  source_payment_id: "pay_1",
  source_invoice_id: "130",
  invoice_ref: "130",
  invoice_face_value: 1200,
  dollars_recovered: 1200,
  band: "band1",
  rate: 0.22,
  fee_amount: 264,
  captured_at: "2026-06-28T00:00:00.000Z",
  cycle_close: "2026-07-15",
  engine_version: "revshare-v1",
};

describe("insertLedgerRow", () => {
  it("clean insert → { inserted:true, id }", async () => {
    const deps = depsWith({ rev_share_ledger: [{ data: { id: "led_1" }, error: null }] });
    expect(await deps.insertLedgerRow(LEDGER_ROW)).toEqual({ inserted: true, id: "led_1" });
  });

  it("23505 conflict → looks up existing → { inserted:false, existingId }", async () => {
    const deps = depsWith({
      rev_share_ledger: [
        { data: null, error: { code: "23505", message: "duplicate key value" } },
        { data: { id: "led_existing" }, error: null }, // the existing-row lookup
      ],
    });
    expect(await deps.insertLedgerRow(LEDGER_ROW)).toEqual({
      inserted: false,
      existingId: "led_existing",
    });
  });

  it("other db error → throws", async () => {
    const deps = depsWith({
      rev_share_ledger: [{ data: null, error: { code: "23502", message: "null value" } }],
    });
    await expect(deps.insertLedgerRow(LEDGER_ROW)).rejects.toThrow(/insertLedgerRow failed/);
  });
});

// A Supabase stub that additionally records the payload handed to
// rev_share_ledger.insert(), so we can assert the invoice_number enrichment gate.
function makeRecordingSupabase(
  queues: Record<string, Result[]>,
  captured: { payload?: Record<string, unknown> },
) {
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ["select", "eq", "not", "limit", "maybeSingle", "single"]) {
      builder[m] = vi.fn(chain);
    }
    builder.insert = vi.fn((payload: Record<string, unknown>) => {
      if (table === "rev_share_ledger") captured.payload = payload;
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

function recordingDeps(queues: Record<string, Result[]>, captured: { payload?: Record<string, unknown> }) {
  vi.mocked(getSupabase).mockReturnValue(makeRecordingSupabase(queues, captured) as never);
  return createLiveCaptureDeps(QBO_PAYMENT);
}

describe("insertLedgerRow invoice_number enrichment gate", () => {
  it("stripe_recovery source → re-queries the invoice and stamps invoice_number", async () => {
    const captured: { payload?: Record<string, unknown> } = {};
    const deps = recordingDeps(
      {
        invoices: [{ data: [{ invoice_number: "1038" }], error: null }],
        rev_share_ledger: [{ data: { id: "led_sr" }, error: null }],
      },
      captured,
    );

    const row: LedgerInsert = {
      ...LEDGER_ROW,
      source: "stripe_recovery",
      source_payment_id: "pi_x",
      source_invoice_id: "145",
    };
    expect(await deps.insertLedgerRow(row)).toEqual({ inserted: true, id: "led_sr" });
    expect(captured.payload?.invoice_number).toBe("1038");
  });

  it("stripe_recovery source, 0 or ambiguous invoice matches → invoice_number null (never guesses)", async () => {
    const captured: { payload?: Record<string, unknown> } = {};
    const deps = recordingDeps(
      {
        invoices: [{ data: [{ invoice_number: "a" }, { invoice_number: "b" }], error: null }],
        rev_share_ledger: [{ data: { id: "led_sr2" }, error: null }],
      },
      captured,
    );

    const row: LedgerInsert = {
      ...LEDGER_ROW,
      source: "stripe_recovery",
      source_payment_id: "pi_y",
      source_invoice_id: "145",
    };
    expect(await deps.insertLedgerRow(row)).toEqual({ inserted: true, id: "led_sr2" });
    expect(captured.payload?.invoice_number).toBeNull();
  });

  it("qbo source → no invoice re-query, payload carries no invoice_number key", async () => {
    const captured: { payload?: Record<string, unknown> } = {};
    // No `invoices` queue on purpose: if the gate leaked and re-queried, the stub
    // would reject with "no queued result for table invoices".
    const deps = recordingDeps(
      { rev_share_ledger: [{ data: { id: "led_q" }, error: null }] },
      captured,
    );

    expect(await deps.insertLedgerRow(LEDGER_ROW)).toEqual({ inserted: true, id: "led_q" });
    expect(captured.payload).toBeDefined();
    expect("invoice_number" in (captured.payload as object)).toBe(false);
  });
});

describe("paymentTimesFor", () => {
  it("qbo → CreateTime as recordedAt, capturedAt (TxnDate) as the date-only fallback", () => {
    expect(paymentTimesFor(QBO_PAYMENT)).toEqual({ recordedAt: CREATE_TIME, txnDate: "2026-09-23T00:00:00.000Z" });
    expect(paymentTimesFor(QBO_TXNDATE_ONLY)).toEqual({ recordedAt: null, txnDate: "2026-09-23T00:00:00.000Z" });
  });
  it("stripe_recovery → the real capturedAt as recordedAt, no date fallback", () => {
    expect(paymentTimesFor({ paymentAt: "2026-09-26T13:05:00.000Z", source: "stripe_recovery" })).toEqual({
      recordedAt: "2026-09-26T13:05:00.000Z",
      txnDate: null,
    });
  });
});

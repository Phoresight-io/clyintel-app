import { describe, it, expect } from 'vitest';
import { processCaptureEvent } from './processCaptureEvent';
import { CaptureDeps, LedgerInsert } from './captureDeps';
import { CaptureEvent } from './captureEvent';
import { computeRevShareFee } from '../revshare/computeRevShareFee';

type SubResult =
  | { ok: true; subscriberId: string }
  | { ok: false; reason: 'subscriber_not_found' | 'ambiguous_subscriber' };

interface Overrides {
  source?: { id: string; active: boolean } | null; // undefined → default active source
  resolve?: SubResult;
  found?: boolean;
  outreachSent?: boolean;
  isActive?: boolean;
}

/** Build fully-mocked deps + an inserts log; a shared store enforces idempotency. */
function makeDeps(o: Overrides = {}) {
  const inserts: LedgerInsert[] = [];
  const store = new Map<string, string>(); // (source::source_payment_id) → ledgerId
  let seq = 0;

  const deps: CaptureDeps = {
    resolveSubscriber: async () => o.resolve ?? { ok: true, subscriberId: 'sub_1' },
    getSource: async () =>
      o.source === undefined ? { id: 'qbo', active: true } : o.source,
    getInvoiceAttribution: async () => ({
      found: o.found ?? true,
      outreachSent: o.outreachSent ?? true,
    }),
    isSubscriberActive: async () => o.isActive ?? true,
    insertLedgerRow: async (row) => {
      inserts.push(row);
      const key = `${row.source}::${row.source_payment_id}`;
      const existing = store.get(key);
      if (existing) return { inserted: false, existingId: existing };
      const id = `ledger_${++seq}`;
      store.set(key, id);
      return { inserted: true, id };
    },
  };

  return { deps, inserts };
}

const baseEvent: CaptureEvent = {
  source: 'qbo',
  sourcePaymentId: 'pay_1',
  sourceInvoiceId: 'inv_1',
  invoicePastDue: true,
  invoiceFaceValue: 1200,
  dollarsRecovered: 1200,
  capturedAt: '2026-06-28T12:00:00Z',
  connectedAccountRef: 'acct_1',
};

const ev = (over: Partial<CaptureEvent> = {}): CaptureEvent => ({ ...baseEvent, ...over });

describe('processCaptureEvent', () => {
  it('1. happy path → written; band/rate/fee match the engine', async () => {
    const { deps, inserts } = makeDeps();
    const res = await processCaptureEvent(ev(), deps);
    const engine = computeRevShareFee({ invoiceFaceValue: 1200, dollarsRecovered: 1200 });

    expect(res).toEqual({
      status: 'written',
      ledgerId: 'ledger_1',
      feeAmount: engine.feeAmount, // 264
      band: 'band1',
      rate: 0.22,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      subscriber_id: 'sub_1',
      source: 'qbo',
      source_payment_id: 'pay_1',
      source_invoice_id: 'inv_1',
      invoice_ref: 'inv_1',
      invoice_face_value: 1200,
      dollars_recovered: 1200,
      band: 'band1',
      rate: 0.22,
      fee_amount: 264,
      captured_at: '2026-06-28T12:00:00Z',
      cycle_close: '2026-07-15', // capturedAt is the 28th (>15) → next month's 15th
      engine_version: 'revshare-v1',
    });
  });

  it('2. invoicePastDue=false → no_fee: not_past_due', async () => {
    const { deps, inserts } = makeDeps();
    const res = await processCaptureEvent(ev({ invoicePastDue: false }), deps);
    expect(res).toEqual({ status: 'no_fee', reason: 'not_past_due' });
    expect(inserts).toHaveLength(0);
  });

  it('3. outreachSent=false → no_fee: no_outreach', async () => {
    const { deps, inserts } = makeDeps({ outreachSent: false });
    const res = await processCaptureEvent(ev(), deps);
    expect(res).toEqual({ status: 'no_fee', reason: 'no_outreach' });
    expect(inserts).toHaveLength(0);
  });

  it('4. isSubscriberActive=false → no_fee: subscriber_inactive', async () => {
    const { deps, inserts } = makeDeps({ isActive: false });
    const res = await processCaptureEvent(ev(), deps);
    expect(res).toEqual({ status: 'no_fee', reason: 'subscriber_inactive' });
    expect(inserts).toHaveLength(0);
  });

  it('5. unknown source → rejected: unknown_source', async () => {
    const { deps, inserts } = makeDeps({ source: null });
    const res = await processCaptureEvent(ev(), deps);
    expect(res).toEqual({ status: 'rejected', reason: 'unknown_source' });
    expect(inserts).toHaveLength(0);
  });

  it('6. inactive source → rejected: inactive_source', async () => {
    const { deps, inserts } = makeDeps({ source: { id: 'qbo', active: false } });
    const res = await processCaptureEvent(ev(), deps);
    expect(res).toEqual({ status: 'rejected', reason: 'inactive_source' });
    expect(inserts).toHaveLength(0);
  });

  it('7. subscriber not found → rejected: subscriber_not_found', async () => {
    const { deps } = makeDeps({ resolve: { ok: false, reason: 'subscriber_not_found' } });
    const res = await processCaptureEvent(ev(), deps);
    expect(res).toEqual({ status: 'rejected', reason: 'subscriber_not_found' });
  });

  it('8. ambiguous subscriber → rejected: ambiguous_subscriber', async () => {
    const { deps } = makeDeps({ resolve: { ok: false, reason: 'ambiguous_subscriber' } });
    const res = await processCaptureEvent(ev(), deps);
    expect(res).toEqual({ status: 'rejected', reason: 'ambiguous_subscriber' });
  });

  it('9. below-$300 face (engine non-qualifying) → no_fee: below_minimum', async () => {
    const { deps, inserts } = makeDeps();
    const res = await processCaptureEvent(
      ev({ invoiceFaceValue: 250, dollarsRecovered: 250 }),
      deps,
    );
    expect(res).toEqual({ status: 'no_fee', reason: 'below_minimum' });
    expect(inserts).toHaveLength(0);
  });

  it('10. partial payment <$300 on a qualifying invoice (face ≥$300) → written; fee = rate × partial', async () => {
    const { deps } = makeDeps();
    const res = await processCaptureEvent(
      ev({ invoiceFaceValue: 10000, dollarsRecovered: 250 }),
      deps,
    );
    // face 10000 → band2 (17%); fee = 0.17 × 250 = 42.50
    expect(res).toEqual({
      status: 'written',
      ledgerId: 'ledger_1',
      feeAmount: 42.5,
      band: 'band2',
      rate: 0.17,
    });
  });

  it('11. idempotency — same (source, sourcePaymentId) twice → written then duplicate, one row persisted', async () => {
    const { deps, inserts } = makeDeps();
    const first = await processCaptureEvent(ev(), deps);
    const second = await processCaptureEvent(ev(), deps);

    expect(first).toEqual({
      status: 'written',
      ledgerId: 'ledger_1',
      feeAmount: 264,
      band: 'band1',
      rate: 0.22,
    });
    expect(second).toEqual({ status: 'duplicate', ledgerId: 'ledger_1' });
    // Both attempts hit insertLedgerRow; the second resolved to the existing row.
    expect(inserts).toHaveLength(2);
  });

  it('12. fee equality — core fee === direct computeRevShareFee output (no drift)', async () => {
    const { deps } = makeDeps();
    const event = ev({ invoiceFaceValue: 7777.77, dollarsRecovered: 7777.77 });
    const res = await processCaptureEvent(event, deps);
    const engine = computeRevShareFee({
      invoiceFaceValue: 7777.77,
      dollarsRecovered: 7777.77,
    });
    expect(res.status).toBe('written');
    if (res.status === 'written') {
      expect(res.feeAmount).toBe(engine.feeAmount); // 1322.22, floored
      expect(res.band).toBe(engine.band);
      expect(res.rate).toBe(engine.rate);
    }
  });
});

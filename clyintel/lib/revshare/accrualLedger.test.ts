import { describe, it, expect } from 'vitest';
import {
  nextCycleCloseDate,
  totalAccrued,
  groupIntoCurrentCycle,
  LedgerSeedRow,
} from './accrualLedger';

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('nextCycleCloseDate', () => {
  it('before the 15th → 15th of the current month', () => {
    expect(iso(nextCycleCloseDate(new Date(Date.UTC(2026, 5, 10))))).toBe('2026-06-15');
  });

  it('on the 1st → 15th of the current month', () => {
    expect(iso(nextCycleCloseDate(new Date(Date.UTC(2026, 2, 1))))).toBe('2026-03-15');
  });

  it('on the 15th itself (boundary, inclusive) → that same 15th', () => {
    expect(iso(nextCycleCloseDate(new Date(Date.UTC(2026, 5, 15))))).toBe('2026-06-15');
  });

  it('after the 15th → 15th of next month', () => {
    expect(iso(nextCycleCloseDate(new Date(Date.UTC(2026, 5, 28))))).toBe('2026-07-15');
  });

  it('rolls over the year: late December → 15th of next January', () => {
    expect(iso(nextCycleCloseDate(new Date(Date.UTC(2026, 11, 20))))).toBe('2027-01-15');
  });

  it('is timezone-stable: a late-UTC-day reference still lands on the 15th', () => {
    expect(iso(nextCycleCloseDate(new Date('2026-06-10T23:30:00Z')))).toBe('2026-06-15');
  });
});

describe('totalAccrued', () => {
  it('empty rows → 0', () => {
    expect(totalAccrued([])).toBe(0);
  });

  it('sums computed fees across bands (264 + 1020 + 3600 + 3600 = 8484)', () => {
    const rows: LedgerSeedRow[] = [
      { invoiceRef: 'A', faceValue: 1200, dollarsRecovered: 1200, detectedAt: '2026-06-02' }, // band1 22% → 264
      { invoiceRef: 'B', faceValue: 8500, dollarsRecovered: 6000, detectedAt: '2026-06-05' }, // band2 17% → 1020
      { invoiceRef: 'C', faceValue: 30000, dollarsRecovered: 30000, detectedAt: '2026-06-09' }, // band3 12% → 3600
      { invoiceRef: 'D', faceValue: 62000, dollarsRecovered: 45000, detectedAt: '2026-06-11' }, // band4 8% → 3600
    ];
    expect(totalAccrued(rows)).toBe(8484);
  });

  it('stays cent-exact with fractional fees (1099.99 + 850 + 42.50 = 1992.49)', () => {
    const rows: LedgerSeedRow[] = [
      { invoiceRef: 'A', faceValue: 4999.99, dollarsRecovered: 4999.99, detectedAt: '2026-06-01' }, // band1 → 1099.99
      { invoiceRef: 'B', faceValue: 5000, dollarsRecovered: 5000, detectedAt: '2026-06-01' },       // band2 → 850
      { invoiceRef: 'C', faceValue: 10000, dollarsRecovered: 250, detectedAt: '2026-06-01' },       // band2 → 42.50
    ];
    expect(totalAccrued(rows)).toBe(1992.49);
  });

  it('excludes non-qualifying rows (< $300 face contributes 0)', () => {
    const rows: LedgerSeedRow[] = [
      { invoiceRef: 'A', faceValue: 1000, dollarsRecovered: 1000, detectedAt: '2026-06-01' }, // 220
      { invoiceRef: 'B', faceValue: 299.99, dollarsRecovered: 299.99, detectedAt: '2026-06-01' }, // 0
    ];
    expect(totalAccrued(rows)).toBe(220);
  });
});

describe('groupIntoCurrentCycle', () => {
  const rows: LedgerSeedRow[] = [
    { invoiceRef: 'A', faceValue: 1200, dollarsRecovered: 1200, detectedAt: '2026-06-02' },
    { invoiceRef: 'B', faceValue: 8500, dollarsRecovered: 6000, detectedAt: '2026-06-05' },
  ];

  it('returns close date, computed rows, and total together', () => {
    const cycle = groupIntoCurrentCycle(rows, new Date(Date.UTC(2026, 5, 28)));
    expect(iso(cycle.cycleCloseDate)).toBe('2026-07-15');
    expect(cycle.rows).toHaveLength(2);
    expect(cycle.rows[0].result.band).toBe('band1');
    expect(cycle.rows[1].result.band).toBe('band2');
    expect(cycle.totalAccrued).toBe(264 + 1020);
  });

  it('handles an empty ledger', () => {
    const cycle = groupIntoCurrentCycle([], new Date(Date.UTC(2026, 5, 10)));
    expect(iso(cycle.cycleCloseDate)).toBe('2026-06-15');
    expect(cycle.rows).toHaveLength(0);
    expect(cycle.totalAccrued).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { computeRevShareFee } from './computeRevShareFee';

describe('computeRevShareFee', () => {
  const cases = [
    // name,                              face,     recovered, qualifies, band,    rate, fee
    ['band1 mid',                          1000,     1000,     true,  'band1', 0.22,  220],
    ['band1 upper edge (exclusive)',       4999.99,  4999.99,  true,  'band1', 0.22,  1099.99],
    ['band2 lower edge (inclusive)',       5000,     5000,     true,  'band2', 0.17,  850],
    ['band2/3 boundary',                   25000,    25000,    true,  'band3', 0.12,  3000],
    ['band3/4 boundary',                   50000,    50000,    true,  'band4', 0.08,  4000],
    ['min edge below',                     299.99,   299.99,   false, null,    0,     0],
    ['min edge at',                        300,      300,      true,  'band1', 0.22,  66],
    ['partial <$300 on qualifying invoice', 10000,   250,      true,  'band2', 0.17,  42.50],
    ['zero recovery on qualifying invoice', 1000,    0,        true,  'band1', 0.22,  0],
    ['floor proof',                        7777.77,  7777.77,  true,  'band2', 0.17,  1322.22],
  ] as const;

  it.each(cases)(
    '%s',
    (_name, face, recovered, qualifies, band, rate, fee) => {
      const result = computeRevShareFee({
        invoiceFaceValue: face,
        dollarsRecovered: recovered,
      });
      expect(result.qualifies).toBe(qualifies);
      expect(result.band).toBe(band);
      expect(result.rate).toBe(rate);
      expect(result.feeAmount).toBe(fee);
    },
  );

  it('is deterministic — same input yields same output', () => {
    const input = { invoiceFaceValue: 7777.77, dollarsRecovered: 7777.77 };
    expect(computeRevShareFee(input)).toEqual(computeRevShareFee(input));
  });

  it('floors fees down, never exceeding the true mathematical amount', () => {
    // 4999.99 * 0.22 = 1099.9978 → floored to 1099.99 (not rounded to 1100.00)
    const { feeAmount } = computeRevShareFee({
      invoiceFaceValue: 4999.99,
      dollarsRecovered: 4999.99,
    });
    expect(feeAmount).toBe(1099.99);
    expect(feeAmount).toBeLessThanOrEqual(4999.99 * 0.22);
  });
});

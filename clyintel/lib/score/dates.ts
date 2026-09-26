// UTC calendar-date math shared by the scorer and the UI (lib/adapters.ts), so
// the Client Score rail and the invoice table's "Due In" column always agree.
//
// Day counts are the whole-day difference between UTC calendar dates. The time
// of day is ignored, so there is no rounding and no afternoon +1. (The old helper
// did Math.round((due − now) / 1 day), which counted one day too many after
// 12:00 UTC: due 2026-06-28 at 2026-09-25T21:00Z came out as 90 instead of 89.)

const MS_PER_DAY = 86_400_000;

// 'YYYY-MM-DD' of an instant's UTC calendar date.
export function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Epoch ms of UTC midnight for a 'YYYY-MM-DD…' string or an instant; null if invalid.
function utcMidnight(value: string | Date): number | null {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : utcMidnight(d);
}

// Whole days from `fromYmd` to `asOf`'s UTC date: positive when asOf is later.
// Due 2026-06-28, asOf any time on 2026-09-25 UTC → 89. Due today → 0; due
// tomorrow → -1. Both sides are UTC midnights, so the division is exact (UTC has
// no DST). null when either input is unparseable.
export function daysBetweenUtcDates(fromYmd: string, asOf: Date | string): number | null {
  const from = utcMidnight(fromYmd);
  const to = utcMidnight(asOf);
  if (from === null || to === null) return null;
  return (to - from) / MS_PER_DAY;
}

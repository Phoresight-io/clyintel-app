// Monthly Settlement Sweep — cron boundary helper (PURE, injected clock).
//
// The cron must settle the MOST RECENTLY CLOSED cycle — never bill early. Cycles
// close on the 15th (UTC), the same rule the frozen capture core stamps onto
// rev_share_ledger.cycle_close (accrualLedger.nextCycleCloseDate). But that helper
// is FORWARD-looking: after the 15th it returns NEXT month's 15th, which as a
// sweep boundary would pull in fees that haven't closed yet. So the cron uses this
// BACKWARD-looking boundary instead:
//   • day >= 15 → the 15th of the current month (today, once we're on/after it)
//   • day <  15 → the 15th of the previous month (this month's cycle hasn't closed)
// UTC throughout; Date.UTC handles month/year rollover (Jan → previous Dec).

/** Most recent cycle-close date (a 15th, UTC) on or before `now`, as YYYY-MM-DD. */
export function mostRecentClosedCycleClose(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  // day >= 15 → this month's 15th; else the previous month's 15th (rolls the year).
  const closed = day >= 15 ? new Date(Date.UTC(year, month, 15)) : new Date(Date.UTC(year, month - 1, 15));
  return closed.toISOString().slice(0, 10);
}

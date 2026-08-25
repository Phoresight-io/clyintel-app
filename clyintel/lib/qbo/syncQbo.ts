// Single client-side implementation of "run a QuickBooks sync", so every surface
// (Connections tile today, the Settings card in T2) triggers the exact same
// request and parses the exact same shape. POSTs /api/qbo/sync and returns the
// server's typed result, or throws an Error carrying the server's message.
//
// This is the trigger wrapper only — all sync logic (token refresh, QBO pull,
// invoice/client upsert, balance-event emission) lives server-side in the route.

export interface QboSyncResult {
  customersUpserted: number;
  invoicesUpserted: number;
  invoicesSkipped: number;
  outreachAttemptsCreated: number;
  balanceEventsEmitted: number;
}

export async function syncQbo(): Promise<QboSyncResult> {
  let res: Response;
  try {
    res = await fetch("/api/qbo/sync", { method: "POST" });
  } catch {
    throw new Error("Network error — please try again.");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Sync failed.");
  }

  const data = (await res.json()) as Partial<QboSyncResult>;
  return {
    customersUpserted: data.customersUpserted ?? 0,
    invoicesUpserted: data.invoicesUpserted ?? 0,
    invoicesSkipped: data.invoicesSkipped ?? 0,
    outreachAttemptsCreated: data.outreachAttemptsCreated ?? 0,
    balanceEventsEmitted: data.balanceEventsEmitted ?? 0,
  };
}

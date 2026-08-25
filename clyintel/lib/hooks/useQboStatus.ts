"use client";
import { useCallback, useEffect, useState } from "react";

// Single source of QuickBooks connection status for the UI. Wraps GET
// /api/qbo/status so every surface reads the SAME authoritative state
// (connected_accounts, cookie/RLS-scoped) instead of each component re-fetching
// or, worse, reading a divergent source (e.g. localStorage). external_id is
// already masked server-side (e.g. "••••1969").

export interface QboStatus {
  connected: boolean;
  external_id: string | null;
  updated_at: string | null;
  refresh_expires_at: string | null;
}

export interface UseQboStatus {
  status: QboStatus | null; // null until the first fetch resolves
  loading: boolean;
  error: boolean; // true if the status fetch failed (treat as "not connected")
  refetch: () => Promise<void>;
}

const DISCONNECTED: QboStatus = {
  connected: false,
  external_id: null,
  updated_at: null,
  refresh_expires_at: null,
};

export function useQboStatus(): UseQboStatus {
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/qbo/status", { cache: "no-store" });
      if (!res.ok) {
        // 401 (signed out) or 500 — surface as not-connected, flag the error.
        setStatus(DISCONNECTED);
        setError(true);
        return;
      }
      const data = (await res.json()) as Partial<QboStatus>;
      setStatus({
        connected: !!data.connected,
        external_id: data.external_id ?? null,
        updated_at: data.updated_at ?? null,
        refresh_expires_at: data.refresh_expires_at ?? null,
      });
      setError(false);
    } catch {
      setStatus(DISCONNECTED);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { status, loading, error, refetch };
}

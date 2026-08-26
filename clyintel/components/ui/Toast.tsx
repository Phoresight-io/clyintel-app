"use client";
import { useEffect, useState, type ReactNode } from "react";
import { C } from "@/lib/theme";

// Minimal reusable toast primitive: bottom-center, auto-dismisses after
// `durationMs`, plus a manual dismiss (×). Presentational only — the caller owns
// when to show it and what it says. Kept as its own primitive (not inlined)
// because Delta usage is expected to grow beyond the sync-result toast.

interface ToastProps {
  /** Leading content (e.g. a status dot). Optional. */
  icon?: ReactNode;
  /** The message body. */
  children: ReactNode;
  /** Called on auto- or manual-dismiss so the caller can drop the toast. */
  onDismiss: () => void;
  /** Auto-dismiss delay in ms. Default 4000. */
  durationMs?: number;
}

export function Toast({ icon, children, onDismiss, durationMs = 4000 }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [onDismiss, durationMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 28,
        transform: "translateX(-50%)",
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        gap: 12,
        maxWidth: 440,
        padding: "12px 16px",
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.16)",
        fontFamily: C.sans,
        animation: "toastUp 0.22s ease",
      }}
    >
      <style>{`@keyframes toastUp{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}`}</style>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 500, color: C.text, flex: 1 }}>{children}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          border: "none",
          background: "transparent",
          color: C.textDim,
          fontSize: 16,
          lineHeight: 1,
          cursor: "pointer",
          padding: "0 2px",
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

/** A small green status dot, for success toasts. */
export function ToastSuccessDot() {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: C.green,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

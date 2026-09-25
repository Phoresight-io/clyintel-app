// Client Score shared constants and helpers: the single source of truth for the
// scorer (computeClientScore.ts) AND the UI (DetailScreen, ClientListScreen,
// PTRWidget). Pure and client-safe: the only import is the theme color constants.

import { C } from "../theme";
import type { Database } from "../../types/supabase";

export type RiskLevel = Database["public"]["Enums"]["ptr_risk_level"];

export const PROVISIONAL_MIN_DATED = 3;
// Bayesian prior blended into paymentHistory: history = (n·mean + PRIOR) / (n + 1).
export const PRIOR = 70;
export const WEIGHTS = {
  paymentHistory: 0.55,
  currentDelinquency: 0.3,
  exposure: 0.15,
} as const;

// 0–100 score for an invoice paid (or still open) `days` after its due date.
export function latenessScore(days: number): number {
  if (days <= 0) return 100;
  if (days <= 7) return 90;
  if (days <= 15) return 80;
  if (days <= 30) return 65;
  if (days <= 45) return 50;
  if (days <= 60) return 35;
  if (days <= 75) return 25;
  if (days <= 90) return 15;
  if (days <= 105) return 10;
  if (days <= 120) return 5;
  return 0;
}

export function bandFor(score: number): RiskLevel {
  if (score >= 85) return "low";
  if (score >= 70) return "medium";
  if (score >= 55) return "high";
  return "critical";
}

export const BAND_LABEL: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Moderate risk",
  high: "High risk",
  critical: "Severe risk",
};

export const BAND_COLOR: Record<RiskLevel, string> = {
  low: C.green,
  medium: C.amber,
  high: C.orange,
  critical: C.red,
};

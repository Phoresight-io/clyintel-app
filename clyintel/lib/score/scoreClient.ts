// Decision core for app/api/clients/[id]/score/route.ts. The route is a thin
// shell: it authenticates, builds the port, and maps { status, body } onto the
// response. Business rules live here and are unit-tested against a fake port.
// Same split as lib/contacts/mutateContact.ts.
//
// Rules:
//   - Ownership first: the service client bypasses RLS, so port.isClientOwned
//     (a subscriber-scoped SELECT on clients) is the security gate. Not owned or
//     not a UUID → 404, and nothing else runs.
//   - dry_run (GET): compute and return the result. NEVER writes.
//   - write (POST): compute, then upsert one row per (client_id, score_month).
//     Re-scoring in the same month overwrites that month's row.
//   - insufficient_data → 422, no write.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import { computeClientScore, type ScoreInputs, type ScoreRow, type ScoreResult } from "./computeClientScore";
import { loadScoreInputs } from "./loadScoreInputs";

export type ScoreMode = "dry_run" | "write";

// What gets written. ai_model / ai_recommendation / ai_recommendation_at and
// counted_toward_limit are deliberately left out. The upsert therefore never
// clobbers a future AI summary and never touches the plan-limit flag.
export type PtrScoreWrite = Omit<ScoreRow, "ai_model" | "ai_recommendation"> & {
  client_id: string;
  subscriber_id: string;
};

export interface ScorePort {
  isClientOwned(clientId: string): Promise<boolean>;
  loadInputs(clientId: string, asOf: Date): Promise<ScoreInputs>;
  upsertScore(row: PtrScoreWrite): Promise<void>;
}

export interface ScoreResponse {
  status: number;
  body: Record<string, unknown>;
}

export const SCORE_UPSERT_CONFLICT = "client_id,score_month";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function scoreClient(
  args: { clientId: string; subscriberId: string; mode: ScoreMode; asOf: Date },
  port: ScorePort,
): Promise<ScoreResponse> {
  const { clientId, subscriberId, mode, asOf } = args;
  if (!UUID_RE.test(clientId) || !(await port.isClientOwned(clientId))) {
    return { status: 404, body: { error: "Client not found." } };
  }

  const result: ScoreResult = computeClientScore(await port.loadInputs(clientId, asOf));
  if (result.kind === "insufficient_data") {
    return { status: 422, body: { kind: "insufficient_data", written: false } };
  }

  if (mode === "dry_run") {
    return { status: 200, body: { ...result, written: false } };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { kind, ai_model, ai_recommendation, ...fields } = result;
  await port.upsertScore({ ...fields, client_id: clientId, subscriber_id: subscriberId });
  return { status: 200, body: { ...result, written: true } };
}

// Real port over the service-role client.
export function makeScorePort(service: SupabaseClient<Database>, userId: string): ScorePort {
  return {
    async isClientOwned(clientId) {
      const { data, error } = await service
        .from("clients")
        .select("id")
        .eq("id", clientId)
        .eq("subscriber_id", userId)
        .maybeSingle();
      if (error) throw new Error(`score: ownership check failed: ${error.message}`);
      return !!data;
    },
    loadInputs(clientId, asOf) {
      return loadScoreInputs(service, userId, clientId, asOf);
    },
    async upsertScore(row) {
      const { error } = await service
        .from("ptr_scores")
        .upsert(row, { onConflict: SCORE_UPSERT_CONFLICT });
      if (error) throw new Error(`score: upsert failed: ${error.message}`);
    },
  };
}

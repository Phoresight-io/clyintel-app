import type { Json } from "../../types/supabase";
import { verifyWebhookSignature } from "./verifyWebhookSignature";

// Pure decision logic for the QBO webhook route: given the raw body, the
// signature header, and the verifier token, decide what the route should do.
// No I/O — the route owns reading env, the request, and the DB write; this
// helper only classifies so it can be unit-tested without a route harness.
//
// The insert-failure → 500 branch is intentionally NOT modeled here (it is
// pure I/O in the route); it will be exercised by the step-8 sandbox test.
export type WebhookOutcome =
  | { kind: "misconfigured" } // verifier token missing/empty → route returns 500
  | { kind: "unauthorized" } // signature invalid/missing → route returns 401, no persist
  | { kind: "malformed" } // signature valid but body isn't JSON → route returns 400, no persist
  | { kind: "accepted"; payload: Json }; // verified + parsed → route persists and ACKs 200

export function classifyWebhookRequest(
  rawBody: string,
  signatureHeader: string | null | undefined,
  verifierToken: string | null | undefined,
): WebhookOutcome {
  // A missing/empty verifier token is a misconfiguration, NOT a reason to skip
  // verification — never accept unverified traffic.
  if (!verifierToken) return { kind: "misconfigured" };

  if (!verifyWebhookSignature(rawBody, signatureHeader, verifierToken)) {
    return { kind: "unauthorized" };
  }

  // Only parse AFTER verification passes. A verified-but-unparseable body is a
  // real edge — surface it rather than persisting something we can't read.
  let payload: Json;
  try {
    payload = JSON.parse(rawBody) as Json;
  } catch {
    return { kind: "malformed" };
  }

  return { kind: "accepted", payload };
}

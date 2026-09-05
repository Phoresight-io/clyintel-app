// Pure parser/validator for POST /api/outreach/run's OPTIONAL JSON body (C4a).
//
// A body-less / empty request → dry-run, no fence — byte-identical to the
// pre-C4a behavior. Live is now reachable via an explicit `mode`, but a live run
// MUST be fenced to a `subscriberId`: an unfenced live run is rejected here, so
// no request can trigger a live blast across all subscribers. Malformed JSON is
// a 400 (never a silent fall-through to a live default).
//
// No I/O, no dependencies — unit-testable with raw strings.

export type RunMode = "dry_run" | "live";

export type ParsedRunRequest =
  | { ok: true; mode: RunMode; subscriberId: string | undefined }
  | { ok: false; status: 400; error: string };

export function parseRunRequest(rawBody: string): ParsedRunRequest {
  const trimmed = rawBody.trim();
  // Body-less request → today's exact defaults: dry-run, unfenced.
  if (trimmed === "") {
    return { ok: true, mode: "dry_run", subscriberId: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }

  const body = parsed as Record<string, unknown>;

  let mode: RunMode = "dry_run";
  if (body.mode !== undefined) {
    if (body.mode !== "dry_run" && body.mode !== "live") {
      return { ok: false, status: 400, error: 'mode must be "dry_run" or "live"' };
    }
    mode = body.mode;
  }

  let subscriberId: string | undefined;
  if (body.subscriberId !== undefined) {
    if (typeof body.subscriberId !== "string" || body.subscriberId.trim() === "") {
      return { ok: false, status: 400, error: "subscriberId must be a non-empty string" };
    }
    subscriberId = body.subscriberId;
  }

  // Belt-and-suspenders: a live run MUST be fenced to a subscriber. There is no
  // legitimate unfenced live run yet; requiring the fence structurally prevents
  // an accidental live blast to all subscribers.
  if (mode === "live" && subscriberId === undefined) {
    return { ok: false, status: 400, error: "live runs must be fenced to a subscriberId" };
  }

  return { ok: true, mode, subscriberId };
}

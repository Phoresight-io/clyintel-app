import { qboApiBaseUrl } from "./constants";

// Thin QBO Accounting API write client: a single generic authenticated POST to
// `/v3/company/{realmId}/{entityPath}`. Net-new and additive — the frozen
// GET/query client (lib/qbo/client.ts) is NOT modified. Nothing imports this
// yet; Phase 1 (Payment) and Phase 2 (Purchase) will.
//
// Mirrors the GET client's contract exactly:
//   - The access token is INJECTED by the caller (the adapter, which obtains it
//     via getValidAccessToken). This client does NOT import tokens.ts, does NOT
//     refresh, and does NOT read connected_accounts — it stays a trivially
//     testable pure HTTP transport. No retries, caching, or rate-limit logic.
//   - On a non-2xx it THROWS (never returns null / swallows); a 401 gets an
//     auth-flavored message telling the caller to refresh via getValidAccessToken.
//   - Error messages carry the HTTP status + entityPath but NEVER the access
//     token and NEVER the request body.
//   - On success it unwraps QBO's single-entity envelope and attaches a `raw`
//     escape-hatch field, matching the GET client's return shape.
//
// Deliberately generic: NO Payment/Purchase-specific types, no fee logic, no
// idempotency — all of that lives downstream in the adapters.

/**
 * QBO wraps a single written entity under a capitalized key (e.g. `Payment`,
 * `Purchase`), typically alongside scalar metadata such as `time`. This
 * primitive is provider-generic and does not know the wrapper's capitalization,
 * so it detects the envelope structurally: when exactly ONE key holds an object
 * value, that is the wrapper — unwrap it. Anything else (no object-valued key,
 * or more than one) is returned as-is.
 */
function unwrapEnvelope(parsed: unknown): unknown {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }
  const obj = parsed as Record<string, unknown>;
  const objectKeys = Object.keys(obj).filter(
    (k) => obj[k] != null && typeof obj[k] === "object",
  );
  if (objectKeys.length === 1) {
    return obj[objectKeys[0]];
  }
  return parsed;
}

/**
 * POST a QBO entity write and return the unwrapped entity.
 *
 * @param realmId      QBO company (realm) id.
 * @param entityPath   Entity route segment, e.g. `'payment'` or `'purchase'`.
 * @param accessToken  Caller-injected bearer token (from getValidAccessToken).
 * @param body         The QBO entity payload; JSON.stringify'd as the request body.
 *
 * Throws on non-2xx (auth-flavored on 401). On success, unwraps the single
 * `{ "<Wrapper>": {...} }` envelope QBO uses and attaches `raw` (the unwrapped
 * entity); if no single wrapper is present the parsed JSON is returned as-is.
 */
export async function qboPostEntity<T>(
  realmId: string,
  entityPath: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  const url = `${qboApiBaseUrl()}/v3/company/${realmId}/${entityPath}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // NEVER include the access token or the request body in the thrown message.
    if (res.status === 401) {
      throw new Error(
        `QBO ${entityPath} write failed: 401 Unauthorized — ` +
          `access token rejected (may be revoked or expired; the caller must ` +
          `refresh via getValidAccessToken)`,
      );
    }
    throw new Error(`QBO ${entityPath} write failed: HTTP ${res.status}`);
  }

  const parsed = await res.json();
  const inner = unwrapEnvelope(parsed);
  if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
    return { ...(inner as object), raw: inner } as T;
  }
  return inner as T;
}

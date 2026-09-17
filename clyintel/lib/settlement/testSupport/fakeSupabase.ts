// Test-support ONLY — a stateful, in-memory fake of the subset of the Supabase
// (PostgREST) client the settlement charge path and the fee-settlement webhook
// reconcilers exercise. NOT imported by any production code (nothing in app/ or
// the non-test lib/ graph references this file), so it never ships in a build.
//
// It extends the #117 reconciler fake (app/api/stripe-webhook/settlementReconcile
// .test.ts) into a single fake shared by both that suite and the Layer-1 charge-
// path integration test, modeling — with the same chainable builder shape:
//   • fee_settlements    select (eq/in filters, maybeSingle) + update with the
//                        `.not("status","in","(paid,void)")` terminal-state guard
//                        AND the claimed_at compare-and-set (`.or(...).select("id")`)
//   • fee_settlement_lines  select (in filter)
//   • subscribers        select (in filter): stripe_customer_id / test_user /
//                        subscription_status
//   • rev_share_ledger   select (in filter) — the transparency-line join source
//   • app_config         select("value").eq("key",_).maybeSingle()
//   • audit_log          select (eq filters) + insert
// EVERY insert/update is captured in `writes` so a test can assert the payments
// rail (or any other table) is never touched. Selects never write.
//
// Deliberately loose types (Record<string, unknown>) — this mirrors PostgREST's
// dynamic shape and the existing #117 fake; callers cast the client to the
// `Pick<SupabaseClient,"from">` seam the production code accepts.

export type Row = Record<string, unknown>;
export interface AuditRow {
  subscriber_id: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface FakeSeed {
  /** fee_settlements rows (keyed by id). */
  settlements?: Row[];
  /** fee_settlement_lines rows. */
  lines?: Row[];
  /** subscribers rows (keyed by id). */
  subscribers?: Row[];
  /** rev_share_ledger rows (keyed by id). */
  ledger?: Row[];
  /** app_config as a plain { key: value } map (value is the raw jsonb value). */
  appConfig?: Record<string, unknown>;
  /** pre-existing audit_log rows (for dedup fixtures). */
  audit?: AuditRow[];
}

export interface CapturedWrite {
  table: string;
  op: "insert" | "update";
  payload: Record<string, unknown>;
}

export interface FakeSupabase {
  client: { from: (table: string) => unknown };
  feeRows: Map<string, Row>;
  subRows: Map<string, Row>;
  lineRows: Row[];
  ledgerRows: Map<string, Row>;
  configRows: Map<string, unknown>;
  auditRows: AuditRow[];
  writes: CapturedWrite[];
}

// Mutable state a single query builder accumulates before it is awaited.
interface Builder {
  table: string;
  op: "select" | "insert" | "update" | null;
  payload: Record<string, unknown> | null;
  eqf: Record<string, unknown>; // accumulated .eq() filters (the method is b.eq)
  ins: { col: string; list: unknown[] }[];
  single: boolean;
  ret: boolean; // a second .select() after an update → return the changed rows
  notCol: string | null;
  notVals: string | null;
  orExpr: string | null;
  limitN: number | null;
  [k: string]: unknown;
}

type Result = { data: unknown; error: unknown };

export function makeFakeSupabase(seed: FakeSeed = {}): FakeSupabase {
  const idKey = (r: Row) => r.id as string;
  const feeRows = new Map<string, Row>((seed.settlements ?? []).map((r) => [idKey(r), { ...r }]));
  const subRows = new Map<string, Row>((seed.subscribers ?? []).map((r) => [idKey(r), { ...r }]));
  const ledgerRows = new Map<string, Row>((seed.ledger ?? []).map((r) => [idKey(r), { ...r }]));
  const lineRows: Row[] = (seed.lines ?? []).map((r) => ({ ...r }));
  const configRows = new Map<string, unknown>(Object.entries(seed.appConfig ?? {}));
  const auditRows: AuditRow[] = (seed.audit ?? []).map((r) => ({ ...r }));
  const writes: CapturedWrite[] = [];

  const matchRow = (row: Row, b: Builder) =>
    Object.entries(b.eqf).every(([k, v]) => row[k] === v) &&
    b.ins.every(({ col, list }) => list.includes(row[col]));

  // `.not(col,"in","(a,b)")` → row passes when row[col] ∉ {a,b}. No guard → pass.
  const passesNot = (row: Row, col: string | null, vals: string | null) => {
    if (!col || !vals) return true;
    const list = vals.replace(/[()]/g, "").split(",");
    return !list.includes(row[col] as string);
  };

  const rowsFor = (table: string): Row[] => {
    switch (table) {
      case "fee_settlements": return [...feeRows.values()];
      case "subscribers": return [...subRows.values()];
      case "fee_settlement_lines": return lineRows;
      case "rev_share_ledger": return [...ledgerRows.values()];
      case "audit_log": return auditRows as unknown as Row[];
      default: return [];
    }
  };

  function resolve(b: Builder): Result {
    // ── SELECT ────────────────────────────────────────────────────────────────
    if (b.op === "select") {
      if (b.table === "app_config") {
        const key = b.eqf["key"] as string;
        const has = configRows.has(key);
        const one = has ? { value: configRows.get(key) } : null;
        return { data: b.single ? one : (has ? [one] : []), error: null };
      }
      let rows = rowsFor(b.table).filter((r) => matchRow(r, b));
      if (b.limitN != null) rows = rows.slice(0, b.limitN);
      // audit_log reads select only the payload column.
      const shaped = b.table === "audit_log" ? rows.map((r) => ({ payload: (r as unknown as AuditRow).payload })) : rows;
      return { data: b.single ? (shaped[0] ?? null) : shaped, error: null };
    }

    // ── INSERT ──────────────────────────────────────────────────────────────
    if (b.op === "insert") {
      const payload = (b.payload ?? {}) as Record<string, unknown>;
      if (b.table === "audit_log") auditRows.push(payload as unknown as AuditRow);
      writes.push({ table: b.table, op: "insert", payload });
      return { data: null, error: null };
    }

    // ── UPDATE ────────────────────────────────────────────────────────────────
    if (b.op === "update") {
      const payload = (b.payload ?? {}) as Record<string, unknown>;
      if (b.table === "fee_settlements") {
        const id = b.eqf["id"] as string;
        const row = feeRows.get(id);
        const isClaim = payload.status === "charging" && b.orExpr != null;
        if (isClaim) {
          // Single-flight compare-and-set. Claimable iff pending, failed, or a
          // STALE 'charging' (claimed_at older than the cutoff in the .or() expr).
          const cutoff = /claimed_at\.lt\.([^,)]+)/.exec(b.orExpr ?? "")?.[1] ?? null;
          const claimable =
            !!row &&
            (row.status === "pending" ||
              row.status === "failed" ||
              (row.status === "charging" &&
                cutoff !== null &&
                (row.claimed_at == null || (row.claimed_at as string) < cutoff)));
          if (claimable && row) {
            Object.assign(row, payload);
            writes.push({ table: b.table, op: "update", payload });
            return { data: [{ id }], error: null };
          }
          return { data: [], error: null };
        }
        // Guarded (terminal-state) or plain update. Guard failing / missing row →
        // no mutation and no captured write.
        if (row && passesNot(row, b.notCol, b.notVals)) {
          Object.assign(row, payload);
          writes.push({ table: b.table, op: "update", payload });
          return { data: b.ret ? [{ id }] : null, error: null };
        }
        return { data: b.ret ? [] : null, error: null };
      }
      // Any other table (e.g. payments) — capture the attempt so tests can assert
      // it never happens; no row store is modeled for these.
      writes.push({ table: b.table, op: "update", payload });
      return { data: b.ret ? [] : null, error: null };
    }

    return { data: null, error: null };
  }

  function from(table: string): unknown {
    const b: Builder = {
      table, op: null, payload: null, eqf: {}, ins: [], single: false, ret: false,
      notCol: null, notVals: null, orExpr: null, limitN: null,
    };
    b.select = () => { if (b.op === null) b.op = "select"; else b.ret = true; return b; };
    b.insert = (payload: Record<string, unknown>) => { b.op = "insert"; b.payload = payload; return b; };
    b.update = (payload: Record<string, unknown>) => { b.op = "update"; b.payload = payload; return b; };
    b.eq = (col: string, val: unknown) => { b.eqf[col] = val; return b; };
    b.in = (col: string, list: unknown[]) => { b.ins.push({ col, list }); return b; };
    b.or = (expr: string) => { b.orExpr = expr; return b; };
    b.not = (col: string, _op: string, vals: string) => { b.notCol = col; b.notVals = vals; return b; };
    b.maybeSingle = () => { b.single = true; return b; };
    b.limit = (n: number) => { b.limitN = n; return b; };
    b.order = () => b;
    b.range = () => b;
    b.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(b)).then(onF, onR);
    return b;
  }

  return { client: { from }, feeRows, subRows, lineRows, ledgerRows, configRows, auditRows, writes };
}

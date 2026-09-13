import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-isolation proof (RLS).
//
// Proves the row-level-security policies isolate subscribers: authenticated as
// subscriber B, you can read NONE of subscriber A's rows on any subscriber-owned
// table, while still seeing your own.
//
// PROD-SAFE BY CONSTRUCTION — leaves ZERO residue:
//   • one `pg` Client, ONE transaction: BEGIN at start, ROLLBACK in afterAll
//     (always runs, even on assertion failure). Nothing is ever COMMITted.
//   • impersonation is done in Postgres, not via real auth users: fixtures are
//     seeded as the privileged (service) login role (RLS bypassed), then reads
//     run under `SET LOCAL ROLE authenticated` + a `request.jwt.claims` sub, so
//     auth.uid() returns the impersonated subscriber and RLS applies.
//
// EXECUTION IS GATED on SUPABASE_DB_URL. It hits a live Postgres, so when the
// var is absent (e.g. CI / a no-egress sandbox) the whole suite SKIPS with a
// clear message rather than failing. Point SUPABASE_DB_URL at the DB to run it;
// for hosted Supabase include `?sslmode=require` in the URL. `pg` must be
// available at run time: `npm i -D pg` (it is only needed to execute this test).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.SUPABASE_DB_URL;

if (!DB_URL) {
  // Printed once at collection time so the skip reason is obvious in the output.
  console.warn(
    "[tenant-isolation] SUPABASE_DB_URL not set — skipping RLS tenant-isolation test. " +
      "Set SUPABASE_DB_URL (e.g. postgresql://…?sslmode=require) to run it.",
  );
}

// `pg` is resolved lazily and only when the suite actually runs. The specifier is
// typed as `string` so `tsc --noEmit` does not try to resolve the module (pg is
// not a repo dependency); the suite is skipped when DB_URL is absent, so the
// import is never reached in that case either.
const PG_SPECIFIER: string = "pg";

// Subscriber-owned tables keyed by an OWN column that equals a subscriber id.
// (subscribers itself is keyed by `id`; every other table here by `subscriber_id`.)
// `templates` is included via subscriber_id: we assert on A's OWN (non-null)
// template only — global rows (subscriber_id IS NULL) are never matched by an
// equality filter, so they are correctly excluded.
const SUBSCRIBER_COL_TABLES: ReadonlyArray<{ table: string; col: string }> = [
  { table: "subscribers", col: "id" },
  { table: "clients", col: "subscriber_id" },
  { table: "invoices", col: "subscriber_id" },
  { table: "communications", col: "subscriber_id" },
  { table: "voice_calls", col: "subscriber_id" },
  { table: "recovery_attempts", col: "subscriber_id" },
  { table: "payments", col: "subscriber_id" },
  { table: "invoice_cadence_progress", col: "subscriber_id" },
  { table: "recovery_links", col: "subscriber_id" },
  { table: "connected_accounts", col: "subscriber_id" },
  { table: "payout_accounts", col: "subscriber_id" },
  { table: "ptr_scores", col: "subscriber_id" },
  { table: "balance_events", col: "subscriber_id" },
  { table: "rev_share_ledger", col: "subscriber_id" },
  { table: "templates", col: "subscriber_id" },
];

describe.skipIf(!DB_URL)("tenant isolation (RLS)", () => {
  // Typed loosely: `pg` has no @types in this repo and is loaded dynamically.
  let client: any;

  // Generated identities and fixture ids captured during seeding.
  const subA = randomUUID();
  const subB = randomUUID();
  let invA = "";
  let invB = "";
  let clientA = "";
  let clientB = "";

  // Every (table, col, A-value, B-value) checked in both directions. Built after
  // seeding so the join tables can key on the real invoice/client ids.
  let checks: Array<{ table: string; col: string; aVal: string; bVal: string }> = [];

  async function q(sql: string, params: unknown[] = []): Promise<any> {
    return client.query(sql, params);
  }

  // Insert `values` into `table`, returning the new row's id.
  async function insertReturningId(
    table: string,
    columns: string[],
    values: unknown[],
  ): Promise<string> {
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const res = await q(
      `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`,
      values,
    );
    return res.rows[0].id as string;
  }

  // Switch the session to authenticate as `sub`: RLS applies (authenticated role
  // is not the table owner and has no BYPASSRLS), and auth.uid() returns `sub`.
  async function asSubscriber(sub: string): Promise<void> {
    await q("RESET ROLE");
    await q("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub, role: "authenticated" }),
    ]);
    await q("SET LOCAL ROLE authenticated");
  }

  // Rows of `table` where `col = val` that are VISIBLE to the current role.
  // table/col come only from the fixed lists above (never user input).
  async function visibleCount(table: string, col: string, val: string): Promise<number> {
    const res = await q(`SELECT count(*)::int AS n FROM public.${table} WHERE ${col} = $1`, [val]);
    return res.rows[0].n as number;
  }

  beforeAll(async () => {
    const pg: any = await import(PG_SPECIFIER);
    const Client = pg.Client ?? pg.default?.Client;
    client = new Client({ connectionString: DB_URL });
    await client.connect();

    // Open the single transaction that wraps EVERYTHING. Nothing is committed.
    await q("BEGIN");
    await q("RESET ROLE"); // seed as the privileged login role (RLS bypassed)

    // A seeded plan is required for subscribers.plan_id (FK → plans).
    const planRes = await q("SELECT id FROM public.plans ORDER BY created_at LIMIT 1");
    if (planRes.rows.length === 0) {
      throw new Error("tenant-isolation: no rows in public.plans — cannot seed subscribers");
    }
    const planId = planRes.rows[0].id as string;

    // Global helper rows (not subscriber-owned): a cadence (for
    // invoice_cadence_progress.cadence_id) and a capture source (for
    // balance_events.source, an FK → capture_sources.id).
    const cadenceId = await insertReturningId(
      "cadences",
      ["key", "name"],
      [`iso-cad-${randomUUID()}`, "ISO test cadence"],
    );
    const sourceId = `iso-src-${randomUUID()}`;
    await q("INSERT INTO public.capture_sources (id, display_name, kind) VALUES ($1, $2, $3)", [
      sourceId,
      "ISO test source",
      "test",
    ]);

    // Seed one A-owned and one B-owned row in every subscriber-owned table.
    for (const [sub, tag] of [
      [subA, "a"],
      [subB, "b"],
    ] as const) {
      // subscribers (id = the subscriber)
      await q(
        "INSERT INTO public.subscribers (id, business_name, email, plan_id) VALUES ($1, $2, $3, $4)",
        [sub, `ISO ${tag}`, `iso-${tag}-${sub}@example.test`, planId],
      );
      // clients → subscriber_id
      const clientId = await insertReturningId(
        "clients",
        ["subscriber_id", "name"],
        [sub, `ISO client ${tag}`],
      );
      // invoices → subscriber_id (+ client_id)
      const invoiceId = await insertReturningId(
        "invoices",
        ["subscriber_id", "client_id", "status", "amount_cents"],
        [sub, clientId, "sent", 1000],
      );
      // payments → subscriber_id
      const paymentId = await insertReturningId(
        "payments",
        ["subscriber_id", "amount_cents", "status"],
        [sub, 500, "succeeded"],
      );

      // communications → subscriber_id
      await q(
        "INSERT INTO public.communications (subscriber_id, client_id, invoice_id, channel, direction, status) VALUES ($1, $2, $3, $4, $5, $6)",
        [sub, clientId, invoiceId, "email", "outbound", "would_send"],
      );
      // voice_calls → subscriber_id (+ client_id)
      await q(
        "INSERT INTO public.voice_calls (subscriber_id, client_id, invoice_id, status) VALUES ($1, $2, $3, $4)",
        [sub, clientId, invoiceId, "completed"],
      );
      // recovery_attempts → subscriber_id
      await q(
        "INSERT INTO public.recovery_attempts (subscriber_id, client_id, invoice_id, channel, attempt_number, status) VALUES ($1, $2, $3, $4, $5, $6)",
        [sub, clientId, invoiceId, "email", 1, "scheduled"],
      );
      // invoice_cadence_progress → subscriber_id
      await q(
        "INSERT INTO public.invoice_cadence_progress (subscriber_id, invoice_id, cadence_id, step_number) VALUES ($1, $2, $3, $4)",
        [sub, invoiceId, cadenceId, 1],
      );
      // recovery_links → subscriber_id (token unique)
      await q(
        "INSERT INTO public.recovery_links (subscriber_id, invoice_id, link_type, token) VALUES ($1, $2, $3, $4)",
        [sub, invoiceId, "recovery", `iso-tok-${randomUUID()}`],
      );
      // connected_accounts → subscriber_id
      await q(
        "INSERT INTO public.connected_accounts (subscriber_id, provider) VALUES ($1, $2)",
        [sub, "stripe"],
      );
      // payout_accounts → subscriber_id
      await q("INSERT INTO public.payout_accounts (subscriber_id) VALUES ($1)", [sub]);
      // ptr_scores → subscriber_id (+ client_id, score_month)
      await q(
        "INSERT INTO public.ptr_scores (subscriber_id, client_id, score_month) VALUES ($1, $2, $3)",
        [sub, clientId, "2026-01-01"],
      );
      // balance_events → subscriber_id (SELECT-only policy; still seeded as service)
      await q(
        "INSERT INTO public.balance_events (subscriber_id, invoice_id, source, delta_cents, prev_outstanding_cents, new_outstanding_cents, fee_eligible, outreach_had_fired) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [sub, invoiceId, sourceId, -100, 1000, 900, false, false],
      );
      // rev_share_ledger → subscriber_id (SELECT-only policy)
      await q(
        "INSERT INTO public.rev_share_ledger (subscriber_id, band, captured_at, cycle_close, dollars_recovered, fee_amount, invoice_face_value, invoice_ref, rate) VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)",
        [sub, "A", "2026-01-31", 0, 0, 0, `iso-ref-${tag}`, 0],
      );
      // templates → subscriber_id (A's/B's OWN, non-null-subscriber template)
      await q(
        "INSERT INTO public.templates (subscriber_id, channel, name, body, trigger_event) VALUES ($1, $2, $3, $4, $5)",
        [sub, "email", `ISO template ${tag}`, "hello {{client_name}}", "manual"],
      );
      // invoice_payments → via invoice_id (no own subscriber column)
      await q(
        "INSERT INTO public.invoice_payments (invoice_id, payment_id, amount_cents) VALUES ($1, $2, $3)",
        [invoiceId, paymentId, 500],
      );
      // client_contacts → via client_id (no own subscriber column)
      await q(
        "INSERT INTO public.client_contacts (client_id, name, email) VALUES ($1, $2, $3)",
        [clientId, `ISO contact ${tag}`, `contact-${tag}@example.test`],
      );

      if (tag === "a") {
        invA = invoiceId;
        clientA = clientId;
      } else {
        invB = invoiceId;
        clientB = clientId;
      }
    }

    checks = [
      ...SUBSCRIBER_COL_TABLES.map((t) => ({ ...t, aVal: subA, bVal: subB })),
      { table: "invoice_payments", col: "invoice_id", aVal: invA, bVal: invB },
      { table: "client_contacts", col: "client_id", aVal: clientA, bVal: clientB },
    ];
  });

  afterAll(async () => {
    // Always undo everything, even if a seed step or assertion threw.
    if (client) {
      try {
        await client.query("RESET ROLE");
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }
  });

  it("impersonation wires auth.uid() to the requested subscriber", async () => {
    await asSubscriber(subB);
    const res = await q("SELECT auth.uid()::text AS uid");
    expect(res.rows[0].uid).toBe(subB);
  });

  it("authenticated as B: reads NONE of A's rows, but sees its own", async () => {
    await asSubscriber(subB);
    for (const c of checks) {
      expect(
        await visibleCount(c.table, c.col, c.aVal),
        `B must NOT see subscriber A's rows in ${c.table}`,
      ).toBe(0);
      expect(
        await visibleCount(c.table, c.col, c.bVal),
        `B must see its OWN rows in ${c.table} (guards against deny-all false pass)`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("authenticated as A: reads NONE of B's rows, but sees its own (symmetric)", async () => {
    await asSubscriber(subA);
    const res = await q("SELECT auth.uid()::text AS uid");
    expect(res.rows[0].uid).toBe(subA);
    for (const c of checks) {
      expect(
        await visibleCount(c.table, c.col, c.bVal),
        `A must NOT see subscriber B's rows in ${c.table}`,
      ).toBe(0);
      expect(
        await visibleCount(c.table, c.col, c.aVal),
        `A must see its OWN rows in ${c.table}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

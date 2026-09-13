import { describe, it, expect, vi } from "vitest";

// Agent-isolation proof for the Agent 1 outreach (cadence) engine.
//
// Claim: an UNFENCED cadence run stamps every write with its invoice's OWN
// subscriber_id — never a run-level fence, never another tenant's id — so a run
// over a mixed multi-tenant candidate list produces zero cross-tenant bleed.
//
// Pure in-memory: no DB, no network, no engine source changes. The engine is
// fully port-driven (runCadence(now, port) / sendEmailStep(ctx, mode, port)), so
// we inject fake ports that CAPTURE every write. runSendStep delegates to the
// REAL sendEmailStep in dry_run, so the real stamping + would_send logic runs.
//
// Belt-and-suspenders no-egress guard: the two modules the real default ports
// would use — MailerSend (@/lib/email) and the Supabase client factory
// (@/lib/supabase) — are mocked and asserted never-called.

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => ({ messageId: "SHOULD-NOT-BE-CALLED" })),
}));
vi.mock("@/lib/supabase", () => ({
  getSupabase: vi.fn(() => {
    throw new Error("getSupabase must not be called in the isolation test");
  }),
  getPublicSupabase: vi.fn(),
}));

import { sendEmail } from "@/lib/email";
import { getSupabase } from "@/lib/supabase";
import {
  runCadence,
  type RunCadencePort,
  type CadenceDef,
  type CadenceInvoice,
} from "./runCadence";
import { sendEmailStep, COMM_STATUS, type SendEmailPort, type RenderVars } from "./sendEmailStep";
import type { ContactRow } from "./selectRecipients";

// ── Fixture: 2 subscribers, 2 firing invoices each, interleaved by tenant ─────
// Each invoice fires: non-terminal status + outstanding > 0 (not terminated),
// due_date far in the past (past-due), and the single email step has offset 0 so
// it is due today.
const INVOICES: CadenceInvoice[] = [
  { id: "inv-A1", subscriber_id: "sub-A", client_id: "cl-A1", status: "overdue", due_date: "2020-01-01", amount_outstanding_cents: 5000 },
  { id: "inv-B1", subscriber_id: "sub-B", client_id: "cl-B1", status: "overdue", due_date: "2020-01-01", amount_outstanding_cents: 5000 },
  { id: "inv-A2", subscriber_id: "sub-A", client_id: "cl-A2", status: "in_recovery", due_date: "2020-02-01", amount_outstanding_cents: 3000 },
  { id: "inv-B2", subscriber_id: "sub-B", client_id: "cl-B2", status: "overdue", due_date: "2020-02-01", amount_outstanding_cents: 7000 },
];
const EXPECTED_SUB: Record<string, string> = Object.fromEntries(
  INVOICES.map((i) => [i.id, i.subscriber_id]),
);

const CADENCE: CadenceDef = {
  id: "cad-1",
  steps: [{ step_number: 1, channel: "email", offset_business_days: 0 }],
};

const CONTACT: ContactRow = {
  id: "c1", client_id: "cl", email: "payer@example.com", phone: null, is_primary: true,
  role: null, name: null, opt_out_email: false, opt_out_sms: false, opt_out_voice: false,
  contact_type: "poc", email_rank: 1, sms_rank: 1, voice_rank: 1,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};
const TEMPLATE = { id: "tpl-1", subject: "Invoice {{invoice_number}}", body: "Hi {{client_name}} {{payment_link}}" } as never;
const VARS: RenderVars = {
  client_name: "Acme", contact_name: "Ada", invoice_number: "N", amount_due: "$1",
  due_date: "2020-01-01", invoice_date: "2020-01-01", subscriber_name: "Phoresight",
  payment_link: "https://buy.stripe.com/test_123",
};

// Captured writes.
interface StampedWrite { table: string; subscriber_id: string; invoice_id: string }

describe("agent isolation — unfenced cadence run stamps each write with the invoice's own subscriber_id", () => {
  it("produces zero cross-tenant bleed across communications, recovery_attempts, invoice_cadence_progress", async () => {
    const stamped: StampedWrite[] = [];
    const commFinalizeStatuses: string[] = [];
    const progressClaims: Array<{ subscriber_id: string; invoice_id: string; step_number: number }> = [];

    // Fake SendEmailPort — gates all pass so the real orchestrator writes; every
    // write's subscriber_id comes from ctx.subscriberId (= inv.subscriber_id).
    let commSeq = 0;
    const dispatchEmail = vi.fn(async () => ({ messageId: "NO" }));
    const sendPort: SendEmailPort = {
      loadRecipientContact: async (clientId) => ({ ...CONTACT, client_id: clientId }),
      loadActiveSystemDefaultEmailTemplate: async () => TEMPLATE,
      loadRenderVars: async () => VARS,
      loadExistingAttemptNumbers: async () => [],
      insertPendingCommunication: async (row) => {
        const id = `comm-${row.invoice_id}-${++commSeq}`;
        stamped.push({ table: "communications", subscriber_id: row.subscriber_id, invoice_id: row.invoice_id });
        return id;
      },
      finalizeCommunication: async (_id, patch) => {
        commFinalizeStatuses.push(patch.status);
      },
      insertRecoveryAttempt: async (row) => {
        stamped.push({ table: "recovery_attempts", subscriber_id: row.subscriber_id, invoice_id: row.invoice_id });
        return `ra-${row.invoice_id}`;
      },
      dispatchEmail,
      now: () => "2026-07-04T00:00:00.000Z",
    };

    // Fake RunCadencePort — UNFENCED candidate list (mixed tenants), captures the
    // progress claim, and delegates the send to the REAL sendEmailStep(dry_run).
    const releaseCalls: unknown[] = [];
    const finalizeProgressCalls: unknown[] = [];
    const port: RunCadencePort = {
      loadActiveCadence: async () => CADENCE,
      loadCandidateInvoices: async () => INVOICES, // unfenced: all tenants
      loadRecordedStepNumbers: async () => [],
      claimStep: async (row) => {
        progressClaims.push({ subscriber_id: row.subscriber_id, invoice_id: row.invoice_id, step_number: row.step_number });
        stamped.push({ table: "invoice_cadence_progress", subscriber_id: row.subscriber_id, invoice_id: row.invoice_id });
        return "claimed";
      },
      runSendStep: async (ctx) => {
        const res = await sendEmailStep(ctx, "dry_run", sendPort);
        return { outcome: res.outcome, communicationId: res.communicationId, recoveryAttemptId: res.recoveryAttemptId };
      },
      finalizeProgress: async (key, links) => { finalizeProgressCalls.push({ key, links }); },
      releaseProgress: async (key) => { releaseCalls.push(key); },
    };

    const summary = await runCadence(new Date(), port);

    // 1. CORE: every stamped write's subscriber_id equals its invoice's own.
    const mismatches = stamped.filter((w) => w.subscriber_id !== EXPECTED_SUB[w.invoice_id]);
    expect(mismatches, `cross-tenant bleed detected: ${JSON.stringify(mismatches)}`).toEqual([]);

    // 2. NON-VACUOUS: writes for >= 2 distinct subscribers, >= 1 firing invoice each.
    //    (A one-tenant pass — e.g. a fence leaking into the scan — must FAIL here.)
    const subsWritten = new Set(stamped.map((w) => w.subscriber_id));
    expect(subsWritten).toEqual(new Set(["sub-A", "sub-B"]));
    for (const sub of ["sub-A", "sub-B"]) {
      const firedForSub = stamped.filter((w) => w.table === "communications" && w.subscriber_id === sub);
      expect(firedForSub.length, `expected >=1 firing invoice for ${sub}`).toBeGreaterThanOrEqual(1);
    }
    // All four invoices fired; each produced one of each stamped write.
    expect(summary.fired).toBe(4);
    expect(summary.considered).toBe(4);
    expect(stamped.filter((w) => w.table === "communications")).toHaveLength(4);
    expect(stamped.filter((w) => w.table === "recovery_attempts")).toHaveLength(4);
    expect(progressClaims).toHaveLength(4);
    expect(releaseCalls).toHaveLength(0); // every fire finalized, none released

    // 3. ZERO OUTBOUND SENDS. Dry-run wrote would_send markers, not sends.
    expect(dispatchEmail).not.toHaveBeenCalled();
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    expect(vi.mocked(getSupabase)).not.toHaveBeenCalled();
    expect(commFinalizeStatuses).toHaveLength(4);
    expect(commFinalizeStatuses.every((s) => s === COMM_STATUS.wouldSend)).toBe(true);
  });
});

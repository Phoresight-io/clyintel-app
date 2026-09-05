import { describe, it, expect, vi } from "vitest";
import {
  runCadence,
  isTerminated,
  isPastDue,
  nextBusinessDay,
  addBusinessDays,
  selectDueStep,
  utcToday,
  type RunCadencePort,
  type CadenceDef,
  type CadenceInvoice,
} from "./runCadence";

// A single-step email cadence (the seeded default shape): one email step at entry.
const DEFAULT_CADENCE: CadenceDef = {
  id: "cad-1",
  steps: [{ step_number: 1, channel: "email", offset_business_days: 0 }],
};

function invoice(over: Partial<CadenceInvoice> = {}): CadenceInvoice {
  return {
    id: "inv-1",
    subscriber_id: "sub-1",
    client_id: "client-1",
    status: "overdue",
    due_date: "2026-08-20", // a Thursday, before the reference "today" below
    amount_outstanding_cents: 5000,
    ...over,
  };
}

// Fully-stubbed port; each op is a spy. Defaults: one candidate invoice, no prior
// progress, a successful dry-run send.
function makePort(over: Partial<RunCadencePort> = {}): RunCadencePort {
  return {
    loadActiveCadence: vi.fn(async () => DEFAULT_CADENCE),
    loadCandidateInvoices: vi.fn(async () => [invoice()]),
    loadRecordedStepNumbers: vi.fn(async () => [] as number[]),
    claimStep: vi.fn(async () => "claimed" as const),
    runSendStep: vi.fn(async () => ({
      outcome: "would_send",
      communicationId: "comm-1",
      recoveryAttemptId: "ra-1",
    })),
    finalizeProgress: vi.fn(async () => {}),
    releaseProgress: vi.fn(async () => {}),
    ...over,
  };
}

// Reference clock: Monday 2026-08-24 12:00 UTC.
const MON = new Date("2026-08-24T12:00:00.000Z");

describe("utcToday", () => {
  it("is the UTC calendar date of the injected clock", () => {
    expect(utcToday(new Date("2026-08-24T23:59:59.000Z"))).toBe("2026-08-24");
  });
});

describe("isTerminated — fail-closed terminus", () => {
  it("paid / written_off halt", () => {
    expect(isTerminated({ status: "paid", amount_outstanding_cents: 5000 })).toBe(true);
    expect(isTerminated({ status: "written_off", amount_outstanding_cents: 5000 })).toBe(true);
  });
  it("outstanding = 0 halts even when status is non-terminal (disagreement → terminated)", () => {
    expect(isTerminated({ status: "overdue", amount_outstanding_cents: 0 })).toBe(true);
  });
  it("null outstanding halts (anomalous → terminated)", () => {
    expect(isTerminated({ status: "overdue", amount_outstanding_cents: null })).toBe(true);
  });
  it("active with a positive balance is NOT terminated", () => {
    expect(isTerminated({ status: "overdue", amount_outstanding_cents: 1 })).toBe(false);
  });
});

describe("isPastDue — DATE granularity, due==today is NOT past due", () => {
  it("due yesterday → past due; due today → not; due tomorrow → not", () => {
    expect(isPastDue("2026-08-23", "2026-08-24")).toBe(true);
    expect(isPastDue("2026-08-24", "2026-08-24")).toBe(false); // boundary
    expect(isPastDue("2026-08-25", "2026-08-24")).toBe(false);
  });
  it("null due_date → not past due (fail closed)", () => {
    expect(isPastDue(null, "2026-08-24")).toBe(false);
  });
});

describe("business-day math (UTC, Sat/Sun skipped)", () => {
  it("nextBusinessDay skips the weekend: Friday → Monday", () => {
    expect(nextBusinessDay("2026-08-21")).toBe("2026-08-24"); // Fri → Mon
  });
  it("nextBusinessDay is strictly after: Thursday → Friday", () => {
    expect(nextBusinessDay("2026-08-20")).toBe("2026-08-21"); // Thu → Fri
  });
  it("addBusinessDays(entry, 0) is the entry itself", () => {
    expect(addBusinessDays("2026-08-24", 0)).toBe("2026-08-24");
  });
  it("addBusinessDays walks over a weekend: Fri + 1 → Mon", () => {
    expect(addBusinessDays("2026-08-21", 1)).toBe("2026-08-24");
    expect(addBusinessDays("2026-08-20", 3)).toBe("2026-08-25"); // Thu +3 → Tue
  });
});

describe("selectDueStep", () => {
  it("returns the first unrecorded step when due", () => {
    const step = selectDueStep(DEFAULT_CADENCE, "2026-08-24", new Set(), "2026-08-24");
    expect(step?.step_number).toBe(1);
  });
  it("returns null when the first unrecorded step is not yet due", () => {
    const cadence: CadenceDef = {
      id: "c",
      steps: [{ step_number: 1, channel: "email", offset_business_days: 3 }],
    };
    // entry Monday + 3 business days = Thursday; today is Monday → not due yet.
    expect(selectDueStep(cadence, "2026-08-24", new Set(), "2026-08-24")).toBeNull();
  });
  it("advances one step at a time — step 1 recorded → step 2 becomes the gate", () => {
    const cadence: CadenceDef = {
      id: "c",
      steps: [
        { step_number: 1, channel: "email", offset_business_days: 0 },
        { step_number: 2, channel: "email", offset_business_days: 0 },
      ],
    };
    const next = selectDueStep(cadence, "2026-08-24", new Set([1]), "2026-08-24");
    expect(next?.step_number).toBe(2);
  });
  it("returns null when every step is recorded (cadence complete)", () => {
    expect(selectDueStep(DEFAULT_CADENCE, "2026-08-24", new Set([1]), "2026-08-24")).toBeNull();
  });
});

describe("runCadence — terminus states each halt (no send, no progress)", () => {
  for (const inv of [
    { label: "paid", over: { status: "paid" } },
    { label: "written_off", over: { status: "written_off" } },
    { label: "outstanding=0", over: { amount_outstanding_cents: 0 } },
    { label: "disagreement (overdue + outstanding 0)", over: { status: "overdue", amount_outstanding_cents: 0 } },
  ]) {
    it(`${inv.label} → terminated, nothing fired`, async () => {
      const port = makePort({ loadCandidateInvoices: vi.fn(async () => [invoice(inv.over)]) });
      const summary = await runCadence(MON, port);
      expect(summary.terminated).toBe(1);
      expect(summary.fired).toBe(0);
      expect(port.claimStep).not.toHaveBeenCalled();
      expect(port.runSendStep).not.toHaveBeenCalled();
    });
  }
});

describe("runCadence — past-due boundary", () => {
  it("due_date == today → NOT past due, nothing fired", async () => {
    const port = makePort({
      loadCandidateInvoices: vi.fn(async () => [invoice({ due_date: "2026-08-24" })]),
    });
    const summary = await runCadence(MON, port);
    expect(summary.notPastDue).toBe(1);
    expect(port.runSendStep).not.toHaveBeenCalled();
  });

  it("due_date == yesterday (Fri) → past due, entry Monday, step fires today (Mon)", async () => {
    // due Friday 2026-08-21; entry = next business day = Monday 2026-08-24 = today.
    const port = makePort({
      loadCandidateInvoices: vi.fn(async () => [invoice({ due_date: "2026-08-21" })]),
    });
    const summary = await runCadence(MON, port);
    expect(summary.fired).toBe(1);
    expect(port.runSendStep).toHaveBeenCalledTimes(1);
    expect(port.runSendStep).toHaveBeenCalledWith({
      subscriberId: "sub-1",
      clientId: "client-1",
      invoiceId: "inv-1",
    });
  });

  it("weekend skip: due Thursday, run on Saturday → entry Friday already passed, fires", async () => {
    // due Thu 2026-08-20; entry = Fri 2026-08-21; run Sat 2026-08-22 → today >= entry.
    const SAT = new Date("2026-08-22T12:00:00.000Z");
    const port = makePort({
      loadCandidateInvoices: vi.fn(async () => [invoice({ due_date: "2026-08-20" })]),
    });
    const summary = await runCadence(SAT, port);
    expect(summary.fired).toBe(1);
  });
});

describe("runCadence — step firing + dry-run + claim/finalize", () => {
  it("would_send (dry-run): claim written, then finalized with links — net progress row UNCHANGED", async () => {
    const port = makePort();
    const summary = await runCadence(MON, port);
    expect(summary.fired).toBe(1);
    expect(port.runSendStep).toHaveBeenCalledOnce();
    // Claim goes in FIRST, before the send, with the (invoice, step) identity.
    expect(port.claimStep).toHaveBeenCalledWith({
      subscriber_id: "sub-1",
      invoice_id: "inv-1",
      cadence_id: "cad-1",
      step_number: 1,
    });
    // Then the claim is finalized with the send artifacts — the surviving row is
    // (invoice, step) + links, identical to the pre-C2/3 single-insert end state.
    expect(port.finalizeProgress).toHaveBeenCalledWith(
      { invoice_id: "inv-1", step_number: 1 },
      { communication_id: "comm-1", recovery_attempt_id: "ra-1" },
    );
    expect(port.releaseProgress).not.toHaveBeenCalled();
  });

  it("sent (live path via injected fake): claim → finalized with communication + recovery ids", async () => {
    const port = makePort({
      runSendStep: vi.fn(async () => ({
        outcome: "sent",
        communicationId: "comm-live",
        recoveryAttemptId: "ra-live",
      })),
    });
    const summary = await runCadence(MON, port);
    expect(summary.fired).toBe(1);
    expect(port.finalizeProgress).toHaveBeenCalledWith(
      { invoice_id: "inv-1", step_number: 1 },
      { communication_id: "comm-live", recovery_attempt_id: "ra-live" },
    );
    expect(port.releaseProgress).not.toHaveBeenCalled();
  });

  it("send_failed (live path): claim → DELETED (released) → step retryable, nothing fired", async () => {
    const port = makePort({
      runSendStep: vi.fn(async () => ({
        outcome: "send_failed",
        communicationId: "comm-x",
        recoveryAttemptId: "ra-x",
      })),
    });
    const summary = await runCadence(MON, port);
    expect(summary.fired).toBe(0);
    expect(summary.skippedNoArtifact).toBe(1);
    expect(port.claimStep).toHaveBeenCalledOnce();
    expect(port.releaseProgress).toHaveBeenCalledWith({ invoice_id: "inv-1", step_number: 1 });
    expect(port.finalizeProgress).not.toHaveBeenCalled();
    // Released → the step is un-recorded, so a subsequent run would re-select it.
    expect(selectDueStep(DEFAULT_CADENCE, "2026-08-24", new Set(), "2026-08-24")?.step_number).toBe(1);
  });

  it("concurrent claim: unique violation → clean skip, no send, no second progress row", async () => {
    const port = makePort({ claimStep: vi.fn(async () => "already_claimed" as const) });
    const summary = await runCadence(MON, port);
    expect(summary.alreadyClaimed).toBe(1);
    expect(summary.fired).toBe(0);
    expect(port.runSendStep).not.toHaveBeenCalled();
    expect(port.finalizeProgress).not.toHaveBeenCalled();
    expect(port.releaseProgress).not.toHaveBeenCalled();
  });
});

describe("runCadence — idempotency (recorded step is the guard)", () => {
  it("re-invocation same day with step 1 already recorded → no second send", async () => {
    const port = makePort({ loadRecordedStepNumbers: vi.fn(async () => [1]) });
    const summary = await runCadence(MON, port);
    expect(summary.noStepDue).toBe(1);
    expect(summary.fired).toBe(0);
    expect(port.claimStep).not.toHaveBeenCalled();
    expect(port.runSendStep).not.toHaveBeenCalled();
  });
});

describe("runCadence — multi-step walk advances one step per invocation", () => {
  const TWO_STEP: CadenceDef = {
    id: "cad-2",
    steps: [
      { step_number: 1, channel: "email", offset_business_days: 0 },
      { step_number: 2, channel: "email", offset_business_days: 1 },
    ],
  };
  it("run 1 (no progress) fires step 1 only; run 2 next business day fires step 2", async () => {
    // due Friday → entry Monday. Step 1 offset 0 = Mon; step 2 offset 1 = Tue.
    const inv = invoice({ due_date: "2026-08-21" });

    // Run 1 on Monday: step 1 due, step 2 (Tue) not yet.
    const port1 = makePort({
      loadActiveCadence: vi.fn(async () => TWO_STEP),
      loadCandidateInvoices: vi.fn(async () => [inv]),
    });
    const s1 = await runCadence(MON, port1);
    expect(s1.fired).toBe(1);
    expect((port1.claimStep as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({
      step_number: 1,
    });

    // Run 2 on Tuesday with step 1 already recorded: step 2 now due.
    const TUE = new Date("2026-08-25T12:00:00.000Z");
    const port2 = makePort({
      loadActiveCadence: vi.fn(async () => TWO_STEP),
      loadCandidateInvoices: vi.fn(async () => [inv]),
      loadRecordedStepNumbers: vi.fn(async () => [1]),
    });
    const s2 = await runCadence(TUE, port2);
    expect(s2.fired).toBe(1);
    expect((port2.claimStep as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({
      step_number: 2,
    });
  });
});

describe("runCadence — gate-suppressed skips (claim released, NO orphan)", () => {
  // Gates run inside sendEmailStep, AFTER the claim is written in runCadence. A
  // suppressed outcome therefore claims then RELEASES — net: no progress row, and
  // crucially no orphan claim (the C2/3 invariant).
  for (const outcome of ["no_primary_contact", "channel_denied", "no_template", "no_payment_link"]) {
    it(`${outcome} → claim released, finalize never called, nothing fired`, async () => {
      const port = makePort({
        runSendStep: vi.fn(async () => ({ outcome, communicationId: null, recoveryAttemptId: null })),
      });
      const summary = await runCadence(MON, port);
      expect(summary.skippedNoArtifact).toBe(1);
      expect(summary.fired).toBe(0);
      expect(port.claimStep).toHaveBeenCalledOnce();
      expect(port.releaseProgress).toHaveBeenCalledWith({ invoice_id: "inv-1", step_number: 1 });
      expect(port.finalizeProgress).not.toHaveBeenCalled();
    });
  }
});

describe("runCadence — no active cadence → clean no-op", () => {
  it("returns an empty summary and touches no invoices", async () => {
    const port = makePort({ loadActiveCadence: vi.fn(async () => null) });
    const summary = await runCadence(MON, port);
    expect(summary.cadenceId).toBeNull();
    expect(summary.considered).toBe(0);
    expect(port.loadCandidateInvoices).not.toHaveBeenCalled();
  });
});

describe("runCadence — non-email step is an unsupported-channel skip (1c seam)", () => {
  it("sms step → not executed, no send, no progress", async () => {
    const port = makePort({
      loadActiveCadence: vi.fn(async () => ({
        id: "cad-sms",
        steps: [{ step_number: 1, channel: "sms", offset_business_days: 0 }],
      })),
      loadCandidateInvoices: vi.fn(async () => [invoice({ due_date: "2026-08-21" })]),
    });
    const summary = await runCadence(MON, port);
    expect(summary.unsupportedChannel).toBe(1);
    expect(port.claimStep).not.toHaveBeenCalled();
    expect(port.runSendStep).not.toHaveBeenCalled();
  });
});

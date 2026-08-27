import { describe, it, expect } from "vitest";
import {
  deriveAttentionReason,
  isAttentionWorthy,
  ATTENTION_REASON,
  type UnreachabilityEvent,
} from "./deriveAttentionReason";

describe("deriveAttentionReason — reason-coded, deterministic", () => {
  it("returns null when there are no events", () => {
    expect(deriveAttentionReason([])).toBeNull();
  });

  it("maps each single event to its reason code", () => {
    expect(deriveAttentionReason(["opt_out"])).toBe(ATTENTION_REASON.opt_out);
    expect(deriveAttentionReason(["hard_bounce"])).toBe(ATTENTION_REASON.hard_bounce);
    expect(deriveAttentionReason(["spam_complaint"])).toBe(ATTENTION_REASON.spam_complaint);
  });

  it("picks the most severe event regardless of input order", () => {
    expect(deriveAttentionReason(["opt_out", "spam_complaint", "hard_bounce"]))
      .toBe(ATTENTION_REASON.spam_complaint);
    expect(deriveAttentionReason(["opt_out", "hard_bounce"]))
      .toBe(ATTENTION_REASON.hard_bounce);
  });

  it("ignores a transient soft-bounce (not attention-worthy)", () => {
    expect(deriveAttentionReason(["soft_bounce" as unknown as UnreachabilityEvent])).toBeNull();
    // a soft-bounce alongside a real event does not change the outcome
    expect(deriveAttentionReason(["soft_bounce" as unknown as UnreachabilityEvent, "opt_out"]))
      .toBe(ATTENTION_REASON.opt_out);
  });

  it("isAttentionWorthy accepts the three events and rejects soft_bounce/unknown", () => {
    expect(isAttentionWorthy("opt_out")).toBe(true);
    expect(isAttentionWorthy("hard_bounce")).toBe(true);
    expect(isAttentionWorthy("spam_complaint")).toBe(true);
    expect(isAttentionWorthy("soft_bounce")).toBe(false);
    expect(isAttentionWorthy("whatever")).toBe(false);
  });
});

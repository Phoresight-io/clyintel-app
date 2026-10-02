import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

// Run log: one durable record per factory run. Writes a JSONL line to
// .factory/runs/run-<run_id>.json (one file per run, committed with the branch, so it travels in the PR and
// can feed a dashboard later). Reads the .factory artifacts to capture outcomes.
// Pure stdlib — no dependencies, never throws into the pipeline.

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

function parseTitle(planMd) {
  const m = planMd.match(/^#\s*Plan:\s*(.+)$/m);
  return m ? m[1].trim() : "(untitled)";
}

// The ONE parser for the tester's report, shared with the orchestrator's test gate so
// the gate, the run log and the PR can never disagree. Fails closed: only an explicit
// "## Result: PASS" is PASS. The last Result line wins, and the unfilled template line
// "## Result: PASS | FAIL" is not a result.
export function parseTestResult(text) {
  if (!text) return "none";
  const all = [...text.matchAll(/##\s*Result:\s*\**\s*(PASS|FAIL)\b(?!\s*\|)/gi)];
  return all.length ? all[all.length - 1][1].toUpperCase() : "unknown";
}

// Why the tester reported FAIL, from its explicit "## Failure reason: <reason>" line (last one wins;
// the unfilled template line with "|" in it does not count). Anything else is "unknown", which the
// orchestrator treats like an ordinary test failure: only the exact words below route differently.
export const FAILURE_REASONS = ["plan error", "test failure", "could not run the suite"];
export function parseFailureReason(text) {
  if (!text) return "unknown";
  const all = [...text.matchAll(/^[ \t]*##[ \t]*Failure reason:[ \t]*\**[ \t]*([A-Za-z ]+?)[ \t]*\**[ \t]*$/gim)];
  const last = all.length ? all[all.length - 1][1].toLowerCase() : "";
  return FAILURE_REASONS.includes(last) ? last : "unknown";
}

function testResult() {
  return parseTestResult(read(".factory/test-report.md"));
}

export function reviewVerdict(summary) {
  const s = summary || "";
  // Only an explicit "VERDICT: ..." line (the orchestrator asks the reviewer for it; last one
  // wins, markdown emphasis allowed) counts. There is deliberately NO keyword fallback:
  // "I can't approve this", "disapprove" or "code block" would be misread, and a wrong
  // APPROVE (a green check in Slack) is worse than "unknown".
  const explicit = [...s.matchAll(/^[\s*_]*VERDICT:[\s*_]*(APPROVE|REQUEST CHANGES|BLOCK)(?![A-Za-z])/gim)].pop();
  if (explicit) return explicit[1].toUpperCase();
  return "unknown";
}

// Build the record and append it. Returns the record so the caller can also
// push it to Slack / a Sheet if desired.
export function writeRunLog({ brief, reviewSummary, usage = {} }) {
  const record = {
    ts: new Date().toISOString(),
    run_id: process.env.GITHUB_RUN_ID || "local",
    branch: process.env.BRANCH || "unknown",
    actor: process.env.SLACK_USER || process.env.GITHUB_ACTOR || "unknown",
    // NOT the brief itself: this file is committed (so it ends up in main's history) and POSTed to
    // a third-party Sheet, and briefs in an AR product tend to name customers and invoices. The
    // full brief stays in the workflow log (limited retention) AND in the PR title/body and Slack (durable, visible to repo/channel members). The hash only identifies which brief was used; it does not hide a short or guessable one.
    brief_sha256: createHash("sha256").update(brief ?? "").digest("hex").slice(0, 12),
    brief_chars: (brief ?? "").length,
    plan_title: parseTitle(read(".factory/plan.md")).slice(0, 80),
    test_result: testResult(),
    review_verdict: reviewVerdict(reviewSummary),
    repo: process.env.GITHUB_REPOSITORY || "Phoresight-io/clyintel-app",
    // From the SDK result messages, summed over the orchestrator's query() calls. num_turns counts the
    // main (delegating) session's model turns only; total_cost_usd covers subagents too. An estimate,
    // not a billing statement. guard_denials: tool calls the role guard refused.
    num_turns: Number(usage.turns) || 0,
    total_cost_usd: Math.round((Number(usage.cost) || 0) * 10000) / 10000,
    guard_denials: Number(usage.denials) || 0,
  };

  try {
    mkdirSync(".factory/runs", { recursive: true });
    // One file per run (not a shared append-only log): two open factory PRs never touch the same
    // path, so they cannot conflict with each other once one of them merges.
    writeFileSync(`.factory/runs/run-${record.run_id}.json`, JSON.stringify(record) + "\n");
  } catch (err) {
    console.error("run log write failed:", err);
  }

  return record;
}

// The run record is sent to the run-log Sheet by the publish job, after it has validated the
// record's content, never from here: this code runs in the agent container, which holds no Sheet
// webhook (or any secret but the Anthropic key). A failed run's row comes from notify-failure.

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

// Optional: append a row to a Google Sheet via its API, only if configured.
// Uses a webhook-style endpoint (e.g. an Apps Script or Make webhook URL in
// RUN_LOG_SHEET_WEBHOOK) to avoid pulling in Google auth libraries. No-ops if
// the env var is absent, so it never blocks a run.
export async function pushRunLogToSheet(record) {
  const url = process.env.RUN_LOG_SHEET_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(10_000), // a hung webhook must not hold a finished run until the job timeout
    });
  } catch (err) {
    console.error("run log sheet push failed:", err);
  }
}

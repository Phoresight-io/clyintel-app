import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

// Run log: one durable record per factory run. Writes a JSONL line to
// .factory/runs/log.jsonl (committed with the branch, so it travels in the PR and
// can feed a dashboard later). Reads the .factory artifacts to capture outcomes.
// Pure stdlib — no dependencies, never throws into the pipeline.

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

function parseTitle(planMd) {
  const m = planMd.match(/^#\s*Plan:\s*(.+)$/m);
  return m ? m[1].trim() : "(untitled)";
}

function testResult() {
  const r = read(".factory/test-report.md");
  if (!r) return "none";
  return /##\s*Result:\s*FAIL/i.test(r) ? "FAIL" : /##\s*Result:\s*PASS/i.test(r) ? "PASS" : "unknown";
}

function reviewVerdict(summary) {
  const s = summary || "";
  if (/BLOCK/i.test(s)) return "BLOCK";
  if (/REQUEST CHANGES/i.test(s)) return "REQUEST CHANGES";
  if (/APPROVE/i.test(s)) return "APPROVE";
  return "unknown";
}

// Build the record and append it. Returns the record so the caller can also
// push it to Slack / a Sheet if desired.
export function writeRunLog({ brief, reviewSummary }) {
  const record = {
    ts: new Date().toISOString(),
    run_id: process.env.GITHUB_RUN_ID || "local",
    branch: process.env.BRANCH || "unknown",
    actor: process.env.SLACK_USER || process.env.GITHUB_ACTOR || "unknown",
    brief,
    plan_title: parseTitle(read(".factory/plan.md")),
    test_result: testResult(),
    review_verdict: reviewVerdict(reviewSummary),
    repo: process.env.GITHUB_REPOSITORY || "Phoresight-io/clyintel-app",
  };

  try {
    mkdirSync(".factory/runs", { recursive: true });
    appendFileSync(".factory/runs/log.jsonl", JSON.stringify(record) + "\n");
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
    });
  } catch (err) {
    console.error("run log sheet push failed:", err);
  }
}

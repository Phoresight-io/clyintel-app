import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chdir } from "node:process";
import { postSlack } from "./slack.mjs";
import { writeRunLog, pushRunLogToSheet, parseTestResult } from "./run-log.mjs";
import { makeGuardHook } from "./role-guard.mjs";
import { baseCommit, snapshot, tamperedPaths } from "./instruction-guard.mjs";

// This script lives in scripts/ but the factory operates on the repo root
// (.factory/, git, the app code). Anchor the working directory at the repo root
// so every .factory read/write and git op is correct no matter where node runs.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
chdir(repoRoot);

// Taken before any agent runs: the commit this run started from (the reviewer diffs
// against it), and a snapshot of the files that steer later sessions, used to detect
// agent tampering between runs (see instruction-guard).
const startCommit = baseCommit(repoRoot);
const instructionBaseline = snapshot(repoRoot);

const channel = process.env.SLACK_CHANNEL; // undefined when run outside Slack
// The workflow always sets BRIEF (to "" when neither the dispatch payload nor the input has
// one), so `??` would never fall back: refuse an empty brief before any paid agent run.
const brief = (process.env.BRIEF ?? "").trim();
if (!brief) {
  console.error("No brief provided; refusing to start a run with an empty brief.");
  process.exit(1);
}
// Same cap as the Slack handler (workflow_dispatch has no such check): a huge brief would burn a
// paid run and then fail at `gh pr create` (PR bodies are limited to 65,536 characters).
if (brief.length > 4000) {
  console.error("Brief is too long (max 4000 characters); refusing to start a run.");
  process.exit(1);
}

// Load the same prompt bodies the .claude/agents/*.md files hold, so filesystem
// and programmatic definitions stay in sync. (Programmatic wins if both exist.)
const load = (name) =>
  readFileSync(new URL(`../.claude/agents/${name}.md`, import.meta.url), "utf8")
    .replace(/^---[\s\S]*?---\n/, ""); // strip YAML frontmatter, keep the body

const agents = {
  planner: {
    description: "Architect/planner (design). Use FIRST. Brief → plan artifact. No code.",
    prompt: load("planner"),
    // Write is limited to .factory/plan.md by the role guard below.
    tools: ["Read", "Write", "Grep", "Glob", "WebSearch"],
    model: "opus", // the one role that gets the expensive model
    maxTurns: 40,
  },
  coder: {
    description: "Implementation agent. AFTER planner. Reads plan, writes code, commits.",
    prompt: load("coder"),
    tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
    model: "sonnet",
    maxTurns: 100,
  },
  tester: {
    description: "Testing agent. AFTER coder. Writes + runs tests vs acceptance criteria.",
    prompt: load("tester"),
    // Write/Edit are limited to test files + .factory/ by the role guard below.
    tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
    model: "sonnet",
    maxTurns: 80,
  },
  reviewer: {
    description: "Read-only review specialist. LAST. Checks diff + test report vs plan.",
    prompt: load("reviewer"),
    // No Write/Edit; Bash is limited to read-only git by the role guard below.
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    maxTurns: 40,
  },
};

// NOTE: `allowedTools` only AUTO-APPROVES tools (so headless runs don't stall on
// permission prompts); it does NOT restrict them. Roles are enforced by the
// PreToolUse hook (role-guard.mjs), which can deny any call, including from
// subagents: the top-level session may only use Agent/Task/Read (it must delegate),
// the tester may only write test files, and the reviewer's Bash is read-only git.
// Include BOTH "Agent" and "Task": the delegation tool was renamed Agent in
// v2.1.63 but the init list still emits Task, so allow-listing both avoids
// silent non-delegation.
const allowedTools = ["Agent", "Task", "Read", "Grep", "Glob", "Bash", "Write", "Edit", "WebSearch"];

// Cap on top-level (delegating) turns per run(); subagents have their own maxTurns.
const MAX_TURNS = 60;

// Counts hook invocations (reset at the start of each run()) so we can refuse to
// continue if enforcement never ran. This is a tripwire, not a gate: it can only
// report after the fact, so the real protection is the hook failing closed.
let guardCalls = 0;
const hooks = { PreToolUse: [{ hooks: [makeGuardHook(repoRoot, () => guardCalls++)] }] };

class PipelineError extends Error {}

// Runs one delegated step and returns the agent's final text (`result` on the SDK
// result message). Any non-success result (error_max_turns, error_during_execution,
// ...) throws, so a failed run can never be mistaken for a successful one.
async function run(prompt) {
  // Every run() starts a new session that loads project settings and CLAUDE.md. If an
  // earlier agent planted or edited any (hooks in .claude/settings.json, a steering
  // CLAUDE.md), refuse to start the next session.
  const tampered = tamperedPaths(repoRoot, instructionBaseline);
  if (tampered.length) {
    throw new PipelineError(`agent modified instruction/settings files: ${tampered.slice(0, 5).join(", ")}`);
  }
  guardCalls = 0;
  const stream = query({
    prompt,
    options: {
      agents,
      allowedTools,
      hooks,
      maxTurns: MAX_TURNS,
      // Explicit, so CLAUDE.md (schema + billing rules) is always loaded and never
      // depends on the SDK default; excludes user/local settings on the runner.
      settingSources: ["project"],
    },
  });
  let final = null;
  for await (const msg of stream) {
    if (msg.type === "result") final = msg;
  }
  if (!final) throw new PipelineError("agent run ended without a result message");
  if (final.subtype !== "success" || final.is_error) {
    console.error("agent run failed:", final.subtype, final.errors ?? "");
    throw new PipelineError(`agent run failed (${final.subtype})`);
  }
  if (guardCalls === 0) {
    // Tools were never checked, so role limits can't be trusted. Fail closed.
    throw new PipelineError("role guard hook never fired; refusing to trust this run");
  }
  console.log(final.result);
  return final.result;
}

// The test gate fails CLOSED: only an explicit "## Result: PASS" counts as passing (a
// missing report, an unparseable one, a tester that hit maxTurns, or the unfilled
// template line all count as "not passed"). Parsing is shared with the run log.
const testPassed = () =>
  existsSync(".factory/test-report.md") &&
  parseTestResult(readFileSync(".factory/test-report.md", "utf8")) === "PASS";

async function pipeline() {
  await postSlack(channel, `▶️ Design → build → test → review: ${brief}`);

  // Design + build + test, in one delegated run.
  await run(`Run the Clyintel pipeline for this brief:

"${brief}"

In order:
1. Use the planner agent to produce .factory/plan.md (the design).
2. Use the coder agent to implement the plan on the current branch and commit.
3. Use the tester agent to write/run tests against the plan's acceptance criteria
   and write .factory/test-report.md.

Report the tester's PASS/FAIL result. Do not review or deploy yet.`);

  // Test gate: one fix loop if tests failed, so a red build doesn't reach review.
  if (!testPassed()) {
    await postSlack(channel, "⚠️ Tests did not pass — sending back to the coder once.");
    await run(`.factory/test-report.md is missing, unparseable, or reports FAIL. Use
the coder agent to fix the implementation (not the tests) per the failures listed
(or, if there is no report, to make sure the work is complete and committed), then
use the tester agent to re-run the tests and rewrite .factory/test-report.md ending
with a line "## Result: PASS" or "## Result: FAIL".`);
  }

  // Review last — reads the diff AND the test report.
  const verdict = await run(`Use the reviewer agent to review the branch against
.factory/plan.md, .factory/build-notes.md, and .factory/test-report.md. Return
the review, and end your reply with exactly one final line of the form
"VERDICT: APPROVE", "VERDICT: REQUEST CHANGES" or "VERDICT: BLOCK". Then STOP.

The reviewer's only shell access is read-only git, and it is enforced to be written
exactly like this (diff/log/show also need the two --no- flags):
  git --no-pager -c core.fsmonitor=false -c log.showSignature=false diff --no-ext-diff --no-textconv ${startCommit}...HEAD --
(${startCommit} is the commit this run started from; the trailing "--" is required, optionally
followed by paths.) Tell the reviewer to use that form.`);

  const stillFailing = !testPassed();

  // Durable run log: one record per run (in-repo JSONL, + optional Sheet row).
  const record = writeRunLog({ brief, reviewSummary: verdict });
  await pushRunLogToSheet(record);

  // Deploy is not offered here: a human reviews the factory PR (opened by the
  // workflow right after this script) and merges to main; Vercel auto-deploys main.
  await postSlack(
    channel,
    `🔎 Factory reviewer verdict: ${record.review_verdict} (full review stays in the workflow logs).\n\n${stillFailing ? "❌ Tests did not pass (or no test report) — fix before merging. " : record.review_verdict === "APPROVE" ? "✅ Build + test + review complete (self-reported; a human still reviews the PR). " : "⚠️ Tests passed but the factory reviewer did not approve — review carefully. "}` +
      `A pull request for branch \`${process.env.BRANCH ?? "(unknown)"}\` is being opened for human review; ` +
      `merging it to main deploys via Vercel.\n` +
      `📋 Logged: *${record.plan_title}* — tests ${record.test_result}, review ${record.review_verdict}.`
  );
}

try {
  await pipeline();
} catch (err) {
  console.error(err);
  const reason = err instanceof PipelineError ? err.message : "unexpected error (see workflow logs)";
  // Note: exiting non-zero skips the workflow's commit/PR steps, so this record is
  // NOT committed. A failed run is only kept by the Sheet webhook (if configured)
  // and the workflow logs.
  const record = writeRunLog({ brief, reviewSummary: `pipeline failed: ${reason}` });
  await pushRunLogToSheet(record);
  await postSlack(channel, `❌ D3 pipeline failed: ${reason}. No PR will be opened.`);
  process.exit(1); // fail the workflow so the commit/PR steps are skipped
}

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chdir } from "node:process";
import { postSlack } from "./slack.mjs";
import { writeRunLog, pushRunLogToSheet } from "./run-log.mjs";

// This script lives in scripts/ but the factory operates on the repo root
// (.factory/, git, the app code). Anchor the working directory at the repo root
// so every .factory read/write and git op is correct no matter where node runs.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
chdir(repoRoot);

const channel = process.env.SLACK_CHANNEL; // undefined when run outside Slack
const brief = process.env.BRIEF ?? "No brief provided";

// Load the same prompt bodies the .claude/agents/*.md files hold, so filesystem
// and programmatic definitions stay in sync. (Programmatic wins if both exist.)
const load = (name) =>
  readFileSync(new URL(`../.claude/agents/${name}.md`, import.meta.url), "utf8")
    .replace(/^---[\s\S]*?---\n/, ""); // strip YAML frontmatter, keep the body

const agents = {
  planner: {
    description: "Architect/planner (design). Use FIRST. Brief → plan artifact. No code.",
    prompt: load("planner"),
    tools: ["Read", "Grep", "Glob", "WebSearch"],
    model: "opus", // the one role that gets the expensive model
  },
  coder: {
    description: "Implementation agent. AFTER planner. Reads plan, writes code, commits.",
    prompt: load("coder"),
    tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
    model: "sonnet",
  },
  tester: {
    description: "Testing agent. AFTER coder. Writes + runs tests vs acceptance criteria.",
    prompt: load("tester"),
    tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"], // writes tests, not feature code
    model: "sonnet",
  },
  reviewer: {
    description: "Read-only review specialist. LAST. Checks diff + test report vs plan.",
    prompt: load("reviewer"),
    tools: ["Read", "Grep", "Glob", "Bash"], // no Write/Edit — can't modify code
    model: "sonnet",
  },
};

// Include BOTH "Agent" and "Task": the delegation tool was renamed Agent in
// v2.1.63 but the init list still emits Task, so allow-listing both avoids
// silent non-delegation.
const allowedTools = ["Agent", "Task", "Read", "Grep", "Glob", "Bash", "Write", "Edit"];

async function run(prompt) {
  const result = query({ prompt, options: { agents, allowedTools } });
  let summary = "";
  for await (const msg of result) {
    if (msg.type === "result") {
      summary = msg.summary ?? JSON.stringify(msg);
      console.log(summary);
    }
  }
  return summary;
}

const testFailed = () =>
  existsSync(".factory/test-report.md") &&
  /##\s*Result:\s*FAIL/i.test(readFileSync(".factory/test-report.md", "utf8"));

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
if (testFailed()) {
  await postSlack(channel, "⚠️ Tests failed — sending back to the coder once.");
  await run(`The tester reported FAIL in .factory/test-report.md. Use the coder
agent to fix the implementation (not the tests) per the failures listed, commit,
then use the tester agent to re-run and rewrite .factory/test-report.md.`);
}

// Review last — reads the diff AND the test report.
const verdict = await run(`Use the reviewer agent to review the branch against
.factory/plan.md, .factory/build-notes.md, and .factory/test-report.md. Return
the verdict (APPROVE / REQUEST CHANGES / BLOCK). Then STOP — do not deploy.`);

const stillFailing = testFailed();

// Durable run log: one record per run (in-repo JSONL, + optional Sheet row).
const record = writeRunLog({ brief, reviewSummary: verdict });
await pushRunLogToSheet(record);

await postSlack(
  channel,
  `${verdict}\n\n${stillFailing ? "❌ Tests still failing — do not deploy. " : "✅ Build + test + review complete. "}` +
    `Reply \`/d3 approve\` to deploy to prod, or push fixes to the PR.\n` +
    `📋 Logged: *${record.plan_title}* — tests ${record.test_result}, review ${record.review_verdict}.`
);

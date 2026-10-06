import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chdir } from "node:process";
import { writeRunLog, parseTestResult } from "./run-log.mjs";
import { agentEnv, unexpectedCredentials, inSandbox, SANDBOX_MARKER, strayPids, isContainerInit } from "./agent-env.mjs";
import { escapingSymlinks } from "./path-scope.mjs";
import { makeGuardHook } from "./role-guard.mjs";
import { baseCommit, snapshot, tamperedPaths } from "./instruction-guard.mjs";
import { logLine, createTracer, seconds, money } from "./factory-log.mjs";
import { fixStep } from "./fix-loop.mjs";

// ISOLATION. This process and every agent session it starts run inside the agent container
// (d3-factory.yml, "Run pipeline in the agent container"): only the repo is mounted, and the only
// secret in its environment is D3_FACTORY_ANTHROPIC_API_KEY. It posts nothing to Slack and nothing
// to the run-log Sheet: those credentials live in the notify-start, publish and notify-failure
// jobs, which never execute agent code. So refuse to start anywhere else.
const strayCredentials = unexpectedCredentials();
if (strayCredentials.length) {
  console.error(`Refusing to run: credential-like variables reached the agent container: ${strayCredentials.join(", ")}. ` +
    `The agent job must hold exactly one secret, D3_FACTORY_ANTHROPIC_API_KEY.`);
  process.exit(1);
}
// The dedicated key is mandatory (no fallback to the shared ANTHROPIC_API_KEY): stop here, before
// any paid session, if it is missing.
let sessionEnv;
try {
  sessionEnv = agentEnv();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const pid1 = (() => {
  try { return readFileSync("/proc/1/comm", "utf8"); } catch { return ""; }
})();
if (!inSandbox() || !isContainerInit(pid1)) {
  console.error(`Refusing to run outside the agent container (${SANDBOX_MARKER} is not "container", or pid 1 is not the container's init).`);
  process.exit(1);
}

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

// Everything below is logging only (one "[factory] <timestamp> ..." line per event, see
// factory-log.mjs); none of it can change what an agent is allowed to do.
const log = (message) => console.log(logLine(message));
const usage = { turns: 0, cost: 0, denials: 0 }; // summed over every query() call
const tracer = createTracer(log, usage);

const quiet = (fn) => async (input) => {
  try { fn(input); } catch {}
  return {};
};

const hooks = {
  PreToolUse: [{ hooks: [makeGuardHook(repoRoot, () => guardCalls++, tracer.onGuardDecision)] }],
  SubagentStart: [{ hooks: [quiet(tracer.onSubagentStart)] }],
  SubagentStop: [{ hooks: [quiet(tracer.onSubagentStop)] }],
};

class PipelineError extends Error {}

// Runs one delegated step and returns the agent's final text (`result` on the SDK
// result message). Any non-success result (error_max_turns, error_during_execution,
// ...) throws, so a failed run can never be mistaken for a successful one.
async function run(prompt) {
  // Nothing an earlier session started may still be running when the next one begins (a background
  // process could swap files under the reviewer between the role guard's check and the Read). In the
  // agent container the only legitimate processes are init (pid 1) and this one.
  for (const pid of strayPids(readdirSync("/proc"), new Set([1, process.pid]))) {
    try {
      process.kill(pid, "SIGKILL");
      log(`killed leftover process ${pid} before the next session`);
    } catch {}
  }
  // The planner, reviewer and top-level session may only read inside the repo (path-scope.mjs),
  // and their tools follow paths the hook never sees when they walk a directory. A symlink an
  // earlier agent left that points out of the repo (or into .git) stops the run here.
  const links = escapingSymlinks(repoRoot);
  if (links.length) {
    throw new PipelineError(`agent left symlinks that point outside the repository or into .git: ${links.slice(0, 5).join(", ")}`);
  }
  // Every run() starts a new session that loads project settings and CLAUDE.md. If an
  // earlier agent planted or edited any (hooks in .claude/settings.json, a steering
  // CLAUDE.md), refuse to start the next session.
  const tampered = tamperedPaths(repoRoot, instructionBaseline);
  if (tampered.length) {
    throw new PipelineError(`agent modified instruction/settings files: ${tampered.slice(0, 5).join(", ")}`);
  }
  guardCalls = 0;
  const startedAt = Date.now();
  const stream = query({
    prompt,
    options: {
      agents,
      allowedTools,
      hooks,
      maxTurns: MAX_TURNS,
      // Explicit: the read-scope rules resolve relative paths, and Grep/Glob's default search
      // directory, against the repo root.
      cwd: repoRoot,
      // Explicit, so CLAUDE.md (schema + billing rules) is always loaded and never
      // depends on the SDK default; excludes user/local settings on the runner.
      settingSources: ["project"],
      // Only the dedicated key (as ANTHROPIC_API_KEY) and a few harmless variables; see agent-env.mjs.
      env: sessionEnv,
    },
  });
  let final = null;
  for await (const msg of stream) {
    if (msg.type === "result") final = msg;
  }
  if (!final) throw new PipelineError("agent run ended without a result message");
  // Cost and turns are on every result message, errors included, so a failed run is still counted.
  usage.turns += Number(final.num_turns) || 0;
  usage.cost += Number(final.total_cost_usd) || 0;
  log(`run finished (${final.subtype}): ${final.num_turns} main-session turns, ${money(final.total_cost_usd)}, ${seconds(Date.now() - startedAt)}s; running total ${usage.turns} turns, ${money(usage.cost)}`);
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
  // The tester has to be able to run the app's suite. The workflow installs the app's dependencies
  // before this script; if that did not happen, stop now instead of paying for a run whose test
  // result could only be "could not run".
  if (!existsSync("clyintel/node_modules/.bin/vitest")) {
    throw new PipelineError("the app's dependencies are not installed (clyintel/node_modules/.bin/vitest is missing); the tester could not run the suite");
  }
  log(`pipeline start (guard denials are logged as "role-guard DENIED")`);

  // Design + build + test, in one delegated run.
  await run(`Run the Clyintel pipeline for this brief:

"${brief}"

In order:
1. Use the planner agent to produce .factory/plan.md (the design).
2. Use the coder agent to implement the plan on the current branch and commit.
3. Use the tester agent to write/run tests against the plan's acceptance criteria
   and write .factory/test-report.md.

Report the tester's PASS/FAIL result. Do not review or deploy yet.`);

  // Test gate: one fix loop if tests failed, so a red build doesn't reach review. A "plan error" FAIL
  // goes to the planner first (fix-loop.mjs); anything else goes to the coder.
  if (!testPassed()) {
    const step = fixStep(existsSync(".factory/test-report.md") ? readFileSync(".factory/test-report.md", "utf8") : "");
    log(`test gate: not passed, fix route "${step.kind}"`);
    await run(step.prompt);
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

  // Durable run log: one record per run, committed with the branch. The publish job validates it
  // and is the one that sends it to the Sheet and tells Slack (this container holds neither credential).
  const record = writeRunLog({ brief, reviewSummary: verdict, usage });
  log(`pipeline done: tests ${record.test_result}${stillFailing ? " (not passed)" : ""}, reviewer ${record.review_verdict}, ${money(usage.cost)}`);
}

try {
  await pipeline();
} catch (err) {
  console.error(err);
  const reason = err instanceof PipelineError ? err.message : "unexpected error (see workflow logs)";
  // Exiting non-zero fails the agent job, so nothing is bundled or published. notify-failure (which
  // holds the Slack token and the Sheet webhook; this container holds neither) reports the failure.
  log(`pipeline failed: ${reason}; ${usage.turns} turns, ${money(usage.cost)}`);
  process.exit(1); // fail the workflow so the commit/PR steps are skipped
}

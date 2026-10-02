// Enforces agent roles at tool-call time instead of trusting the prompts.
//
// Why a hook and not `allowedTools`: in the Agent SDK, `allowedTools` only
// AUTO-APPROVES tools, it does not restrict them. A PreToolUse hook runs for every
// tool call (including from subagents, where `agent_type` names the subagent) and
// can deny it, so the policy below holds even if an agent is prompt-injected.
//
// Pure functions, no dependencies, so the policy can be unit tested offline
// (see role-guard.test.mjs).

export const SUBAGENTS = ["planner", "coder", "tester", "reviewer"];

// The top-level session must delegate: it can read and hand work to subagents,
// but it cannot code, run shell commands, or edit files itself.
const MAIN_THREAD_TOOLS = new Set(["Agent", "Task", "Read"]);

// Tools each subagent may use at all (mirrors the AgentDefinition `tools`).
const ROLE_TOOLS = {
  planner: new Set(["Read", "Write", "Grep", "Glob", "WebSearch"]),
  coder: new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]),
  tester: new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]),
  reviewer: new Set(["Read", "Grep", "Glob", "Bash"]),
};

// Planner may write exactly its own artifact.
const PLANNER_FILE = /^\.factory\/plan\.md$/;

// Tester may only create/edit test files and its own report. A directory merely
// NAMED test/tests is not enough (app/api/test/route.ts is a live route, and
// lib/tests/x.ts is an importable module), so: a test FILENAME anywhere, or any
// file under a TOP-LEVEL test directory (repo root or clyintel/).
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /^(clyintel\/)?tests?\//;
const TESTER_REPORT = /^\.factory\/test-report\.md$/;
// The multi-tenant isolation test guards against one customer seeing another's
// financial data. The tester may add tests but must not weaken this one.
const TESTER_PROTECTED = /(^|\/)tenant-isolation[^/]*$/;

// Reviewer's Bash is limited to read-only git in ONE canonical form. The prefix
// disables things a coder could have planted in .git/config to run code when the
// reviewer runs git (fsmonitor, signature verification via gpg.program, pagers).
// diff/log/show must also pass --no-ext-diff --no-textconv, which disable external
// diff drivers and textconv filters set via .gitattributes + config.
const GIT_PREFIX = "git --no-pager -c core.fsmonitor=false -c log.showSignature=false ";
// `status` is deliberately absent, and `diff` must compare commits or the index (see
// below): anything that compares WORKTREE files with the index can run clean filters
// (filter.<x>.clean in .git/config + .gitattributes) that a coder planted. -c flags
// and --no-ext-diff/--no-textconv do not disable those.
const GIT_SUBS = new Set(["diff", "log", "show", "rev-parse", "merge-base", "ls-files", "rev-list"]);
const GIT_DRIVER_SUBS = new Set(["diff", "log", "show"]);
// Exact-match flags only. git accepts unambiguous prefixes of long options (so
// --outp= is --output), which makes a denylist unsafe; anything not listed here
// is rejected.
const SAFE_FLAGS = new Set([
  "--no-ext-diff", "--no-textconv", "--stat", "--numstat", "--shortstat",
  "--name-only", "--name-status", "--oneline", "--no-color", "--cached",
  "--staged", "--no-merges", "--first-parent", "--count", "--abbrev-commit",
  "-p", "--patch", "-n",
]);
const SAFE_FLAG_PATTERNS = [
  /^-n\d+$/, /^-U\d+$/, /^--max-count=\d+$/,
  /^--(format|pretty)=(oneline|short|medium|full|fuller)$/,
];
// Refs and paths: a restricted character set (no quotes, spaces, shell
// metacharacters or redirects) and never a leading dash.
const SAFE_ARG = /^[A-Za-z0-9_.\/:@~^,%+][A-Za-z0-9_.\/:@~^=,%+-]*$/;

// Files the coder must not touch with Write/Edit: the factory itself and CI config
// (a feature never needs them), git internals, and the run log. NOTE: this does not
// stop the same edits via Bash; it blocks honest mistakes and the easy path.
// Also the tenant-isolation test: a coder that breaks tenant scoping must not be able to
// make the one test that catches it pass (the tester is already blocked from it).
// And the build/deploy surface, where a change becomes a Vercel preview build or a cron
// change: vercel.json (it defines the every-minute QBO worker and settlement crons),
// next.config.*, and schema/ (CLAUDE.md: "do not invent schema"; migrations come from a
// human). package.json is deliberately NOT blocked: a feature legitimately adds dependencies.
const CODER_PROTECTED = new RegExp(
  [
    "^(\\.claude|\\.github|scripts|\\.git)/",
    "^\\.factory/runs/",
    "^\\.gitignore$",
    "(^|/)tenant-isolation[^/]*$",
    "(^|/)vercel\\.json$",
    "(^|/)next\\.config\\.[cm]?[jt]s$",
    "^(clyintel/)?schema/",
  ].join("|")
);

const deny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

// Normalise a tool-supplied path to a repo-relative, forward-slash path. Returns
// null if it escapes the repo root.
export function repoRelative(filePath, root) {
  if (typeof filePath !== "string" || !filePath) return null;
  const norm = (p) => p.replace(/\\/g, "/");
  const r = norm(root).replace(/\/+$/, "");
  let p = norm(filePath);
  if (p.startsWith("/")) {
    if (p !== r && !p.startsWith(r + "/")) return null;
    p = p.slice(r.length).replace(/^\//, "");
  }
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

export function isTestPath(relPath) {
  return (
    relPath != null &&
    !TESTER_PROTECTED.test(relPath) &&
    (TEST_FILE.test(relPath) || TEST_DIR.test(relPath) || TESTER_REPORT.test(relPath))
  );
}

export function isReadOnlyGit(command) {
  if (typeof command !== "string") return false;
  const c = command.trim();
  if (!c.startsWith(GIT_PREFIX)) return false;
  const [sub, ...args] = c.slice(GIT_PREFIX.length).split(" ");
  if (!GIT_SUBS.has(sub)) return false;

  let noExtDiff = false;
  let noTextconv = false;
  let afterDashDash = false;
  for (const a of args) {
    if (a === "") return false; // stray double space
    if (afterDashDash) {
      if (!SAFE_ARG.test(a)) return false;
    } else if (a === "--") {
      afterDashDash = true;
    } else if (a.startsWith("-")) {
      if (!SAFE_FLAGS.has(a) && !SAFE_FLAG_PATTERNS.some((re) => re.test(a))) return false;
      if (a === "--no-ext-diff") noExtDiff = true;
      if (a === "--no-textconv") noTextconv = true;
    } else if (!SAFE_ARG.test(a)) {
      return false;
    }
  }
  if (GIT_DRIVER_SUBS.has(sub) && !(noExtDiff && noTextconv)) return false;
  // diff only against objects: the index (--cached), or a revision range (a..b / a...b)
  // that is followed by an explicit "--". The "--" matters: without it git reads an
  // argument that is not a valid revision but matches a file as a PATH, so a coder who
  // commits a file literally named "a..b" (plus a clean filter for it) turns
  // "diff HEAD a..b" into a working-tree diff. With "--", git insists the arguments
  // before it are revisions and errors out instead.
  if (sub === "diff") {
    const cached = args.includes("--cached") || args.includes("--staged");
    const dd = args.indexOf("--");
    const revs = dd === -1 ? [] : args.slice(0, dd);
    const hasRange = revs.some((a) => !a.startsWith("-") && a.includes(".."));
    if (!cached && !hasRange) return false;
  }
  return true;
}

const GIT_HINT =
  `reviewer Bash is limited to read-only git, written exactly as: ` +
  `${GIT_PREFIX}<diff|log|show|rev-parse|merge-base|ls-files|rev-list> [safe flags] [refs] [-- paths], ` +
  `diff/log/show must also pass --no-ext-diff --no-textconv, and diff must use --cached or a ` +
  `revision range followed by an explicit "--" (e.g. "diff <flags> main...HEAD --"); no working-tree diffs, no status.`;

// Decide one tool call. `input` is a PreToolUse hook input. Returns a hook output
// object ({} = no objection) — deny wins over any allow rule.
export function decide(input, repoRoot) {
  const { tool_name: tool, tool_input: args = {}, agent_id: agentId, agent_type: agentType } = input;

  // Main thread (no agent_id): delegate only.
  if (!agentId) {
    if (!MAIN_THREAD_TOOLS.has(tool)) {
      return deny(`Top-level session may only use Agent/Task/Read; delegate "${tool}" to a subagent.`);
    }
    // Only our four subagents — never a built-in agent type that has every tool.
    if ((tool === "Agent" || tool === "Task") && !SUBAGENTS.includes(args.subagent_type)) {
      return deny(`Unknown subagent_type "${args.subagent_type}"; use one of: ${SUBAGENTS.join(", ")}.`);
    }
    return {};
  }

  // Subagent calls.
  if (!SUBAGENTS.includes(agentType)) {
    return deny(`Unrecognised subagent type "${agentType}".`);
  }
  if (!ROLE_TOOLS[agentType].has(tool)) {
    return deny(`${agentType} may not use ${tool}.`);
  }

  if (agentType === "coder" && (tool === "Write" || tool === "Edit")) {
    const rel = repoRelative(args.file_path, repoRoot);
    if (rel == null || CODER_PROTECTED.test(rel)) {
      return deny(
        `coder may not ${tool} factory/CI/git files (.claude/, .github/, scripts/, .git/, .gitignore, .factory/runs/), ` +
          `the tenant-isolation test, vercel.json, next.config.*, schema/ ` +
          `or paths outside the repo. Refusing "${args.file_path}".`
      );
    }
  }

  if (agentType === "planner" && tool === "Write") {
    const rel = repoRelative(args.file_path, repoRoot);
    if (rel == null || !PLANNER_FILE.test(rel)) {
      return deny(`planner may only write .factory/plan.md. Refusing Write on "${args.file_path}".`);
    }
  }

  if (agentType === "tester" && (tool === "Write" || tool === "Edit")) {
    const rel = repoRelative(args.file_path, repoRoot);
    if (!isTestPath(rel)) {
      return deny(
        `tester may only write test files (*.test.* / *.spec.*, or files under a top-level test/ or tests/ ` +
          `directory) and .factory/test-report.md. Refusing ${tool} on "${args.file_path}". ` +
          `Report feature-code problems instead of editing them.`
      );
    }
  }

  if (agentType === "reviewer" && tool === "Bash" && !isReadOnlyGit(args.command)) {
    return deny(GIT_HINT);
  }

  return {};
}

// Hook callback for query() options.hooks.PreToolUse. Fails CLOSED: if the policy
// code itself throws, the tool call is denied. `onCall` lets the orchestrator
// verify the hook really fired (so enforcement can't silently be absent).
export function makeGuardHook(repoRoot, onCall = () => {}) {
  return async (input) => {
    onCall();
    try {
      return decide(input, repoRoot);
    } catch (err) {
      return deny(`role guard error (failing closed): ${err?.message ?? err}`);
    }
  };
}

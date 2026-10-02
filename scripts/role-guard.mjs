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
  planner: new Set(["Read", "Grep", "Glob", "WebSearch"]),
  coder: new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]),
  tester: new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]),
  reviewer: new Set(["Read", "Grep", "Glob", "Bash"]),
};

// Tester may only create/edit test files and factory artifacts.
const TEST_PATH = [
  /(^|\/)(__tests__|tests?)\//, // test/, tests/, __tests__/ anywhere in the path
  /\.(test|spec)\.[cm]?[jt]sx?$/, // foo.test.ts, foo.spec.tsx, ...
  /^\.factory\//, // .factory/test-report.md etc.
];

// Reviewer's Bash is limited to read-only git. Arguments are restricted to a safe
// character set (no spaces inside quotes, no shell metacharacters, no redirects).
const READONLY_GIT =
  /^git (diff|log|show|status|rev-parse|merge-base|ls-files|rev-list|blame)( [A-Za-z0-9_.\/:@~^=,%+-]+)*$/;
// Flags that make otherwise read-only git commands write files or run programs.
const UNSAFE_GIT_FLAG = /(^| )(--output|--ext-diff|--textconv|--exec|-c|-C|--git-dir|--work-tree)(=| |$)/;

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
  return relPath != null && TEST_PATH.some((re) => re.test(relPath));
}

export function isReadOnlyGit(command) {
  if (typeof command !== "string") return false;
  const c = command.trim();
  return READONLY_GIT.test(c) && !UNSAFE_GIT_FLAG.test(c);
}

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

  if (agentType === "tester" && (tool === "Write" || tool === "Edit")) {
    const rel = repoRelative(args.file_path, repoRoot);
    if (!isTestPath(rel)) {
      return deny(
        `tester may only write test files (tests/, test/, __tests__/, *.test.*, *.spec.*) or .factory/. ` +
          `Refusing ${tool} on "${args.file_path}". Report feature-code problems instead of editing them.`
      );
    }
  }

  if (agentType === "reviewer" && tool === "Bash" && !isReadOnlyGit(args.command)) {
    return deny("reviewer Bash is limited to read-only git (diff, log, show, status, rev-parse, merge-base, ls-files, rev-list, blame).");
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

// Detects agent tampering with the files that steer LATER agent sessions.
//
// Each run() starts a new session that loads project settings and CLAUDE.md
// (settingSources: ["project"]). The coder has Write + Bash, so it could plant
// .claude/settings.json (shell hooks/env) or edit a CLAUDE.md, and the tester or
// reviewer session would then pick it up outside the role guard's intent. Checked
// before every run(): anything changed, added, deleted or ignored-but-present in
// these paths, compared with the commit the run STARTED from, aborts the pipeline.
//
// The git calls run in the orchestrator process after an agent may have
// booby-trapped .git/config, so they pass command-line overrides (which win over
// repo config) that disable the things git would otherwise execute.

import { execFileSync } from "node:child_process";

// Pathspec magic: any CLAUDE.md / CLAUDE.local.md at any depth (Claude Code loads
// nested ones lazily), and any .claude/ directory at any depth.
// node_modules is deliberately NOT excluded (a nested CLAUDE.md there could also be
// loaded). Dependencies are pinned by scripts/package-lock.json, so this can't change
// silently; if a dependency ever ships one, the first run fails loudly and the path
// can be excluded then.
export const WATCHED = [
  ":(glob)**/CLAUDE.md",
  ":(glob)**/CLAUDE.local.md",
  ":(glob).claude/**",
  ":(glob)**/.claude/**",
];

const SAFE_GIT = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "log.showSignature=false",
];

const git = (cwd, ...args) =>
  execFileSync("git", [...SAFE_GIT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Commit to compare against; take it BEFORE any agent runs.
export const baseCommit = (cwd) => git(cwd, "rev-parse", "HEAD").trim();

// Returns a list of offending paths (empty = untouched).
export function tamperedPaths(cwd, base) {
  const changed = git(cwd, "diff", "--name-only", "--no-ext-diff", "--no-textconv", base, "--", ...WATCHED)
    .split("\n").map((s) => s.trim()).filter(Boolean);
  // --ignored too: an agent can hide a file via .gitignore or .git/info/exclude.
  const status = git(cwd, "status", "--porcelain", "--untracked-files=all", "--ignored", "--", ...WATCHED)
    .split("\n").map((s) => s.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/, ""));
  return [...new Set([...changed, ...status])];
}

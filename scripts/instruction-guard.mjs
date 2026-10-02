// Detects agent tampering with the files that steer LATER agent sessions.
//
// Each run() starts a new session that loads project settings and CLAUDE.md
// (settingSources: ["project"]). The coder has Write + Bash, so it could plant
// .claude/settings.json (shell hooks/env) or edit a CLAUDE.md, and the tester or
// reviewer session would then pick it up outside the role guard's intent.
//
// The orchestrator takes a snapshot of these files BEFORE any agent runs and
// compares against it before every run(); any added, changed or removed file aborts
// the pipeline. This deliberately does NOT use git: the check runs in the
// orchestrator process after an agent may have planted config in .git, and git
// commands that compare the working tree can run planted clean filters. Reading
// and hashing the raw bytes with node:fs executes nothing.

import { readdirSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";

// Watched: any CLAUDE.md / CLAUDE.local.md at any depth (Claude Code loads nested
// ones lazily) and everything under any .claude/ directory.
// Skipped: .git (not instructions) and node_modules. Skipping node_modules is a
// trade-off: an agent-run `npm ci` can create 100k+ files that we'd re-hash on every
// run(), and a CLAUDE.md there is only loaded if an agent reads files in that exact
// directory. scripts/node_modules is pinned by scripts/package-lock.json.
const SKIP_DIRS = new Set([".git", "node_modules"]);
const isWatchedFile = (name) => name === "CLAUDE.md" || name === "CLAUDE.local.md";

// Map of repo-relative path -> sha256 of the raw bytes (or of the link target for a
// symlink; symlinks are never followed).
export function snapshot(root) {
  const out = new Map();
  const walk = (dir, inClaude) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(join(dir, ent.name), inClaude || ent.name === ".claude");
        continue;
      }
      // A symlink named .claude counts as watched too (it would redirect settings).
      if (!(inClaude || ent.name === ".claude" || isWatchedFile(ent.name))) continue;
      const full = join(dir, ent.name);
      const h = createHash("sha256");
      if (lstatSync(full).isSymbolicLink()) h.update("symlink:" + readlinkSync(full));
      else h.update(readFileSync(full));
      out.set(relative(root, full).split(sep).join("/"), h.digest("hex"));
    }
  };
  walk(root, false);
  return out;
}

// Paths that differ from the baseline snapshot (empty = untouched).
export function tamperedPaths(root, baseline) {
  const now = snapshot(root);
  const bad = [];
  for (const [p, h] of now) if (baseline.get(p) !== h) bad.push(p);
  for (const p of baseline.keys()) if (!now.has(p)) bad.push(p);
  return bad.sort();
}

// The commit the run started from (for the reviewer's diff range and PR context).
// Called once, BEFORE any agent runs, with command-line overrides for safety.
export const baseCommit = (cwd) =>
  execFileSync(
    "git",
    ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

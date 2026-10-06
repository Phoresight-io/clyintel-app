// Keeps the read-only file tools (Read, Grep, Glob) of the planner, the reviewer and the
// top-level session inside the repository, and out of .git/.
//
// Why: none of these roles has Bash, so reading a file is their only way to reach something
// outside the code they work on: /proc/self/environ (the session's own environment, which holds
// the Anthropic key), the runner's home, or .git/ (config an agent could have planted, and on a
// misconfigured checkout a credential). The planner can also send what it read to WebSearch.
// The container the agent job runs in is the real boundary; this is the layer inside it.
//
// Two checks per path, both must pass:
//   1. lexical: the path, resolved against the repo root without touching the disk, stays inside
//      it and has no .git segment;
//   2. on disk: the real path (every symlink resolved) stays inside the repo's real path and has no
//      .git segment. The coder has Bash and could leave docs/env -> /proc/self/environ behind;
//      the lexical check alone would let the reviewer read through it.
// Glob patterns and Grep's glob filter are also checked, since a pattern can name a directory.
//
// Hard links: a file hard-linked to one in .git (ln .git/config docs/cfg) has a real path inside the
// repo, so Read, and Grep when its path names a file, refuse any regular file with more than one link.
//
// Limits (accepted; the container is the boundary, and the coder can read all of this anyway):
//   - Grep and Glob walk directories themselves, and the hook only sees where they start. Grep
//     (ripgrep) does not follow symlinks, but the CLI's Glob does (rg --files --follow), so a link
//     planted earlier in the SAME session can expose file NAMES outside the repo to Glob (Read of
//     them is still refused). escapingSymlinks() and the orchestrator's stray-process kill run before
//     every session, so nothing planted carries over into the next one.
//   - hard links are caught only where a tool names the file. Grep or Glob over a DIRECTORY still
//     reads or lists a hard-linked file inside it. Only the coder (Bash) can make one, and it can
//     already read .git itself.
//   - check-then-use: a process running in parallel could swap a checked file for a link between
//     this check and the read. The orchestrator kills leftover processes between sessions.
// Pure node:fs, no dependencies, never executes anything.

import { realpathSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SCOPED_TOOLS = new Set(["Read", "Grep", "Glob"]);

const isGitSegment = (seg) => seg.toLowerCase() === ".git";
const hasGitSegment = (rel) => rel.split(/[\\/]+/).some(isGitSegment);

// "outside" / ".git" / null (fine). Lexical only: no filesystem access.
export function lexicalScope(p, root) {
  if (typeof p !== "string" || p === "") return "outside";
  if (p.startsWith("~")) return "outside"; // the CLI may expand ~ to $HOME
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return "outside";
  return hasGitSegment(rel) ? ".git" : null;
}

// Same verdicts, with every symlink on the way resolved. A path that does not exist yet is judged
// by its deepest existing ancestor. Anything that cannot be resolved (a dangling or looping link,
// an unreadable directory) counts as "outside": fail closed.
export function realScope(p, root) {
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return "outside";
  }
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  let cur = abs;
  const rest = [];
  for (;;) {
    let exists = true;
    try {
      lstatSync(cur);
    } catch {
      exists = false;
    }
    if (exists) break;
    const up = dirname(cur);
    if (up === cur) return "outside";
    rest.unshift(basename(cur));
    cur = up;
  }
  let real;
  try {
    real = join(realpathSync(cur), ...rest);
  } catch {
    return "outside";
  }
  const rel = relative(realRoot, real);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return "outside";
  return hasGitSegment(rel) ? ".git" : null;
}

const pathScope = (p, root) => lexicalScope(p, root) ?? realScope(p, root);

// A glob may only name things relative to the search directory: no "..", no absolute or ~
// alternative (also inside braces, e.g. "{/proc,src}/**"), and no .git segment.
export function globScope(pattern) {
  if (typeof pattern !== "string") return null;
  if (pattern.includes("..")) return "outside";
  if (/(^|[{,])\s*[\\/~]/.test(pattern)) return "outside";
  if (pattern.split(/[\\/{},]+/).some(isGitSegment)) return ".git";
  return null;
}

const WHY = {
  outside: "is outside the repository",
  ".git": "is inside .git/",
  hardlink: "is a hard link (it may be a copy of a file in .git/)",
};

// "hardlink" for an existing regular file with more than one link, else null.
export function hardlinkScope(p, root) {
  try {
    const st = statSync(isAbsolute(p) ? p : resolve(root, p));
    return st.isFile() && st.nlink > 1 ? "hardlink" : null;
  } catch {
    return null; // missing: nothing to read
  }
}

// Returns a denial reason, or null when the call stays in scope. `root` is the session's working
// directory (the repo root), which is also where Grep/Glob search when given no path.
export function scopeViolation(tool, args = {}, root) {
  if (!SCOPED_TOOLS.has(tool)) return null;
  const checks = [];
  if (tool === "Read") {
    const scope = pathScope(args.file_path, root);
    checks.push(["file_path", args.file_path, scope ?? hardlinkScope(args.file_path, root)]);
  } else {
    const path = args.path === undefined || args.path === null || args.path === "" ? "." : args.path;
    const scope = pathScope(path, root);
    // Grep can be pointed straight at a file; hardlinkScope is null for directories.
    checks.push(["path", args.path ?? "(default)", scope ?? (tool === "Grep" ? hardlinkScope(path, root) : null)]);
    if (tool === "Glob") checks.push(["pattern", args.pattern, globScope(args.pattern)]);
    if (tool === "Grep") checks.push(["glob", args.glob, globScope(args.glob)]);
  }
  for (const [field, value, verdict] of checks) {
    if (verdict) {
      return `${tool} ${field} "${String(value).slice(0, 200)}" ${WHY[verdict]}; read-only tools are limited to the repository (excluding .git/).`;
    }
  }
  return null;
}

// Every symlink under `root` (skipping .git, which no scoped tool may enter) whose target resolves
// outside the repository, into .git, or nowhere. node_modules IS walked: an agent with Bash can plant
// a link there as easily as anywhere else. Returns repo-relative paths, sorted.
export function escapingSymlinks(root) {
  const bad = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        // A dangling or looping link resolves to nothing and counts as escaping (fail closed).
        if (realScope(full, root)) bad.push(relative(root, full).split(sep).join("/"));
      } else if (ent.isDirectory() && !isGitSegment(ent.name)) {
        walk(full);
      }
    }
  };
  walk(root);
  return bad.sort();
}

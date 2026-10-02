// Run with: node --test scripts/instruction-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync, chmodSync, symlinkSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { snapshot, tamperedPaths, baseCommit } from "./instruction-guard.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, env: ENV, stdio: "pipe" });
const put = (dir, rel, body = "x") => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

// A repo shaped like ours, with a baseline snapshot taken before any "agent" acts.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ig-"));
  sh(dir, "init", "-q", "-b", "main");
  put(dir, "CLAUDE.md", "root rules");
  put(dir, "clyintel/CLAUDE.md", "product rules");
  put(dir, ".claude/agents/reviewer.md", "reviewer");
  put(dir, "clyintel/app/page.tsx", "page");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "base");
  return { dir, base: snapshot(dir) };
}
const check = (fn) => {
  const { dir, base } = repo();
  try {
    fn(dir);
    return tamperedPaths(dir, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("baseline watches instruction files only", () => {
  const { dir, base } = repo();
  try {
    assert.deepEqual([...base.keys()].sort(), [".claude/agents/reviewer.md", "CLAUDE.md", "clyintel/CLAUDE.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean repo, and ordinary app changes, are not flagged", () => {
  assert.deepEqual(check(() => {}), []);
  assert.deepEqual(
    check((d) => {
      put(d, "clyintel/app/page.tsx", "edited");
      put(d, "clyintel/lib/new.ts", "new");
      put(d, ".factory/plan.md", "plan");
      put(d, "clyintel/tests/a.test.ts", "t");
      put(d, "clyintel/node_modules/x/index.js", "dep"); // skipped on purpose
    }),
    []
  );
});

test("edited CLAUDE.md (unstaged, staged, committed) is flagged", () => {
  assert.deepEqual(check((d) => put(d, "CLAUDE.md", "evil")), ["CLAUDE.md"]);
  assert.deepEqual(check((d) => { put(d, "clyintel/CLAUDE.md", "evil"); sh(d, "add", "-A"); }), ["clyintel/CLAUDE.md"]);
  assert.deepEqual(check((d) => { put(d, "CLAUDE.md", "evil"); sh(d, "commit", "-qam", "sneaky"); }), ["CLAUDE.md"]);
});

test("new settings / nested CLAUDE.md / deleted agent file are flagged", () => {
  assert.deepEqual(check((d) => put(d, ".claude/settings.json", '{"hooks":{}}')), [".claude/settings.json"]);
  assert.deepEqual(check((d) => put(d, "clyintel/lib/CLAUDE.md", "steer")), ["clyintel/lib/CLAUDE.md"]);
  assert.deepEqual(check((d) => put(d, "clyintel/app/deep/CLAUDE.local.md", "steer")), ["clyintel/app/deep/CLAUDE.local.md"]);
  assert.deepEqual(check((d) => put(d, "clyintel/.claude/settings.json", "{}")), ["clyintel/.claude/settings.json"]);
  assert.deepEqual(check((d) => rmSync(join(d, ".claude/agents/reviewer.md"))), [".claude/agents/reviewer.md"]);
});

test("product context (.ai/) and .mcp.json are watched too", () => {
  assert.deepEqual(check((d) => put(d, ".ai/constitution.md", "steer")), [".ai/constitution.md"]);
  assert.deepEqual(check((d) => put(d, "clyintel/.ai/specs/s.md", "steer")), ["clyintel/.ai/specs/s.md"]);
  assert.deepEqual(check((d) => put(d, ".mcp.json", '{"mcpServers":{}}')), [".mcp.json"]);
  assert.deepEqual(check((d) => put(d, "clyintel/.mcp.json", "{}")), ["clyintel/.mcp.json"]);
});

test("hiding a file from git does not hide it from the check", () => {
  assert.deepEqual(
    check((d) => {
      put(d, ".claude/settings.json", "{}");
      appendFileSync(join(d, ".git/info/exclude"), ".claude/settings.json\n");
    }),
    [".claude/settings.json"]
  );
  assert.ok(
    check((d) => {
      put(d, "clyintel/lib/CLAUDE.md", "steer");
      appendFileSync(join(d, ".gitignore"), "CLAUDE.md\n");
    }).includes("clyintel/lib/CLAUDE.md")
  );
});

test("replacing a watched file with a symlink is flagged (and never followed)", () => {
  const flagged = check((d) => {
    unlinkSync(join(d, "CLAUDE.md"));
    symlinkSync("/etc/passwd", join(d, "CLAUDE.md"));
  });
  assert.deepEqual(flagged, ["CLAUDE.md"]);
  // a symlink named .claude redirecting settings is flagged too
  assert.deepEqual(check((d) => symlinkSync("/tmp", join(d, "clyintel/.claude"))), ["clyintel/.claude"]);
});

test("checking executes nothing planted in .git/config (it never calls git)", () => {
  const { dir, base } = repo();
  try {
    const marker = join(dir, "PWNED");
    const script = join(dir, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`);
    chmodSync(script, 0o755);
    put(dir, ".gitattributes", "*.md filter=evil\n");
    sh(dir, "config", "core.fsmonitor", script);
    sh(dir, "config", "filter.evil.clean", script);
    put(dir, "CLAUDE.md", "root rules changed so git must run the clean filter to compare");
    // Control: a plain `git status` really does fire planted code here.
    sh(dir, "status");
    assert.ok(existsSync(marker), "control failed: planted code did not fire on plain git status");
    rmSync(marker);
    assert.deepEqual(tamperedPaths(dir, base), ["CLAUDE.md"]);
    assert.ok(!existsSync(marker), "tamper check executed planted code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pinned dependency tree (scripts/node_modules) must stay byte-identical", () => {
  const withDeps = (fn) => {
    const { dir } = repo();
    try {
      put(dir, "scripts/node_modules/pkg/index.js", "original");
      put(dir, "scripts/node_modules/pkg/bin/cli", "\u0000binary\u0000");
      symlinkSync("../pkg/bin/cli", join(dir, "scripts/node_modules/.link"));
      const base = snapshot(dir);
      fn(dir);
      return tamperedPaths(dir, base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.deepEqual(withDeps(() => {}), []);
  assert.deepEqual(withDeps((d) => put(d, "scripts/node_modules/pkg/index.js", "patched")), ["scripts/node_modules/pkg/index.js"]);
  assert.deepEqual(withDeps((d) => put(d, "scripts/node_modules/pkg/bin/cli", "patched binary")), ["scripts/node_modules/pkg/bin/cli"]);
  assert.deepEqual(withDeps((d) => put(d, "scripts/node_modules/evil/index.js", "new")), ["scripts/node_modules/evil/index.js"]);
  assert.deepEqual(withDeps((d) => rmSync(join(d, "scripts/node_modules/pkg/index.js"))), ["scripts/node_modules/pkg/index.js"]);
  assert.deepEqual(
    withDeps((d) => { unlinkSync(join(d, "scripts/node_modules/.link")); symlinkSync("/bin/sh", join(d, "scripts/node_modules/.link")); }),
    ["scripts/node_modules/.link"]
  );
  // other node_modules are still skipped, and ordinary scripts/ files are not pinned
  assert.deepEqual(withDeps((d) => { put(d, "clyintel/node_modules/x/y.js", "z"); put(d, "scripts/notes.md", "n"); }), []);
});

test("baseCommit returns the HEAD sha", () => {
  const { dir } = repo();
  try {
    assert.match(baseCommit(dir), /^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

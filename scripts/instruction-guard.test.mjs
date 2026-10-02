// Run with: node --test scripts/instruction-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { baseCommit, tamperedPaths } from "./instruction-guard.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, env: ENV, stdio: "pipe" });
const put = (dir, rel, body = "x") => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

// A repo shaped like ours: instructions + app code, committed, then BASE recorded.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ig-"));
  sh(dir, "init", "-q", "-b", "main");
  put(dir, "CLAUDE.md", "root rules");
  put(dir, "clyintel/CLAUDE.md", "product rules");
  put(dir, ".claude/agents/reviewer.md", "reviewer");
  put(dir, "clyintel/app/page.tsx", "page");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "base");
  return { dir, base: baseCommit(dir) };
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

test("clean repo, and ordinary app changes, are not flagged", () => {
  assert.deepEqual(check(() => {}), []);
  assert.deepEqual(
    check((d) => {
      put(d, "clyintel/app/page.tsx", "edited");
      put(d, "clyintel/lib/new.ts", "new");
      put(d, ".factory/plan.md", "plan");
      put(d, "clyintel/tests/a.test.ts", "t");
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

test("a file hidden via .git/info/exclude or .gitignore is still flagged", () => {
  const hiddenExclude = check((d) => {
    put(d, ".claude/settings.json", "{}");
    appendFileSync(join(d, ".git/info/exclude"), ".claude/settings.json\n");
  });
  assert.deepEqual(hiddenExclude, [".claude/settings.json"]);
  const hiddenIgnore = check((d) => {
    put(d, "clyintel/lib/CLAUDE.md", "steer");
    appendFileSync(join(d, ".gitignore"), "CLAUDE.md\n");
  });
  assert.ok(hiddenIgnore.includes("clyintel/lib/CLAUDE.md"), JSON.stringify(hiddenIgnore));
});

test("checking never runs code planted in .git/config (fsmonitor/hooks)", () => {
  const { dir, base } = repo();
  try {
    const marker = join(dir, "PWNED");
    const script = join(dir, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\n`);
    chmodSync(script, 0o755);
    sh(dir, "config", "core.fsmonitor", script);
    sh(dir, "config", "core.hooksPath", dirname(script));
    // Control: the planted fsmonitor really does fire on a plain `git status`.
    sh(dir, "status");
    assert.ok(existsSync(marker), "control failed: planted fsmonitor did not fire");
    rmSync(marker);
    tamperedPaths(dir, base);
    assert.ok(!existsSync(marker), "tamper check executed planted code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

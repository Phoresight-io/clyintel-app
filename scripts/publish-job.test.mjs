// Run with: node --test scripts/publish-job.test.mjs
//
// Regression test for the factory workflow's two shell steps, run for real (bash +
// git) against local repos with stubbed `gh` and `curl`: the "Export commits as a git
// bundle" step in the agent job, and the "Push branch and open PR" step in the
// publish job. It extracts the scripts from d3-factory.yml itself, so an edit to the
// workflow that breaks them (e.g. drops the push) fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/d3-factory.yml"), "utf8");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

// The `run: |` script of the step named `name`, with workflow expressions filled in.
function stepScript(name, subs) {
  const lines = WORKFLOW.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `step not found: ${name}`);
  const r = lines.findIndex((l, k) => k > i && /^\s+run: \|\s*$/.test(l));
  const indent = lines[r].match(/^\s*/)[0].length;
  const body = [];
  for (let k = r + 1; k < lines.length; k++) {
    if (lines[k].trim() === "") { body.push(""); continue; }
    if (lines[k].match(/^\s*/)[0].length <= indent) break;
    body.push(lines[k].slice(indent + 2));
  }
  let script = body.join("\n");
  for (const [k, v] of Object.entries(subs)) script = script.split(k).join(v);
  return script;
}

const sh = (cwd, cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd, env: { ...process.env, ...GIT_ENV, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Build a world: a "GitHub" bare repo, an agent job that makes a factory commit and
// exports the bundle with the REAL export step, and a fresh publish-job checkout.
function world({ log, mutateBundle, fromBranch, baseFiles = {}, baseLink, edit } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pub-"));
  const git = (cwd, ...a) => sh(cwd, "git", a);
  git(root, "init", "-q", "-b", "main", "base");
  writeFileSync(join(root, "base/f"), "base");
  for (const [rel, body] of Object.entries(baseFiles)) {
    mkdirSync(dirname(join(root, "base", rel)), { recursive: true });
    writeFileSync(join(root, "base", rel), body);
  }
  if (baseLink) symlinkSync("f", join(root, "base", baseLink));
  git(join(root, "base"), "add", "-A");
  git(join(root, "base"), "commit", "-qm", "base");
  // a second commit, so that a depth-1 checkout really is shallow (its parent is missing)
  writeFileSync(join(root, "base/history"), "more history");
  git(join(root, "base"), "add", "history");
  git(join(root, "base"), "commit", "-qm", "more history");
  if (fromBranch) {
    // a non-default branch with its own commit, as with workflow_dispatch "Use workflow from"
    git(join(root, "base"), "checkout", "-qb", fromBranch);
    writeFileSync(join(root, "base/rel"), "release work");
    git(join(root, "base"), "add", "rel");
    git(join(root, "base"), "commit", "-qm", "release work");
    git(join(root, "base"), "checkout", "-q", "main");
  }
  git(root, "clone", "-q", "--bare", "base", "remote.git");
  // The runner checks out only the triggering ref, so with fromBranch there is no local "main".
  const cloneArgs = fromBranch ? ["--branch", fromBranch, "--single-branch"] : [];

  // agent job
  git(root, "clone", "-q", ...cloneArgs, "--no-local", `file://${join(root, "remote.git")}`, "job1");
  const j1 = join(root, "job1");
  const sha = git(j1, "rev-parse", "HEAD").trim();
  git(j1, "checkout", "-qb", "factory/run-1");
  writeFileSync(join(j1, "feat.txt"), "feature");
  if (log !== undefined) {
    mkdirSync(join(j1, ".factory/runs"), { recursive: true });
    writeFileSync(join(j1, ".factory/runs/log.jsonl"), log + "\n");
  }
  if (edit) edit({ j1, git: (...a) => git(j1, ...a), put: (rel, body = "x") => { mkdirSync(dirname(join(j1, rel)), { recursive: true }); writeFileSync(join(j1, rel), body); } });
  git(j1, "add", "-A");
  git(j1, "commit", "-qm", "factory change");
  const rt1 = join(root, "rt1");
  mkdirSync(rt1);
  sh(j1, "bash", ["-e", "-c", stepScript("Export commits as a git bundle", { "${{ github.run_id }}": "1", "${{ github.sha }}": sha })], { RUNNER_TEMP: rt1 });
  if (mutateBundle) mutateBundle({ root, j1, rt1, git });

  // publish job: fresh checkout of the base commit, bundle downloaded as an artifact
  // the real publish job uses actions/checkout with the default fetch-depth: 1, so test against a shallow clone
  git(root, "clone", "-q", "--depth", "1", ...cloneArgs, "--no-local", `file://${join(root, "remote.git")}`, "job2");
  assert.equal(git(join(root, "job2"), "rev-parse", "--is-shallow-repository").trim(), "true", "publish checkout must be shallow");
  const rt2 = join(root, "rt2");
  mkdirSync(join(rt2, "bundle"), { recursive: true });
  copyFileSync(join(rt1, "factory.bundle"), join(rt2, "bundle/factory.bundle"));

  // stubs
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("gh", `printf '%s\\0' "$@" > "${root}/gh.args"; echo https://github.com/x/y/pull/9`);
  stub("curl", `for a in "$@"; do case "$a" in \\{*) printf '%s' "$a" > "${root}/slack.payload";; esac; done`);
  return { root, j2: join(root, "job2"), rt2, bin, remote: join(root, "remote.git") };
}

function publish(w, env = {}) {
  return sh(w.j2, "bash", ["-e", "-c", stepScript("Push branch and open PR", { "${{ github.run_id }}": "1" })], {
    PATH: `${w.bin}:${process.env.PATH}`, RUNNER_TEMP: w.rt2, GH_TOKEN: "tok", GITHUB_REPOSITORY: "x/y",
    GITHUB_SHA: sh(w.j2, "git", ["rev-parse", "HEAD"]).trim(), // the publish job checks out the same base commit
    BRANCH: "factory/run-1", BRIEF: "add invoice reminder\nsecond line", SLACK_BOT_TOKEN: "", SLACK_CHANNEL: "", ...env,
  });
}
const ghArgs = (w) => readFileSync(join(w.root, "gh.args"), "utf8").split("\0").slice(0, -1);
const remoteHas = (w, ref) => { try { sh(w.remote, "git", ["rev-parse", "-q", "--verify", ref]); return true; } catch { return false; } };
const cleanup = (w) => rmSync(w.root, { recursive: true, force: true });

test("publish: pushes the branch, then opens a DRAFT PR with the right arguments", () => {
  const w = world({ log: '{"test_result":"PASS","review_verdict":"APPROVE"}' });
  try {
    publish(w);
    assert.ok(remoteHas(w, "refs/heads/factory/run-1"), "branch was not pushed to the remote");
    const a = ghArgs(w);
    assert.deepEqual(a.slice(0, 2), ["pr", "create"]);
    assert.ok(a.includes("--draft"), "factory PRs must always be drafts");
    assert.equal(a[a.indexOf("--head") + 1], "factory/run-1");
    assert.equal(a[a.indexOf("--base") + 1], "main");
    assert.equal(a[a.indexOf("--repo") + 1], "x/y");
    assert.equal(a[a.indexOf("--title") + 1], "Factory: add invoice reminder second line"); // newline stripped
    const body = a[a.indexOf("--body") + 1];
    assert.match(body, /UNVERIFIED/);
    assert.match(body, /Brief:\n\s*```\nadd invoice reminder\nsecond line\n```/);
    assert.match(body, /Tests: PASS \| Factory reviewer verdict: APPROVE/);
  } finally { cleanup(w); }
});

test("publish: a title cut mid-character stays valid UTF-8", () => {
  const brief = "a".repeat(69) + "\u2014 trailing text"; // the em dash straddles byte 70
  const w = world({ edit: ({ put }) => put("clyintel/lib/ok.ts", "ok") });
  try {
    publish(w, { BRIEF: brief });
    const title = ghArgs(w)[ghArgs(w).indexOf("--title") + 1];
    assert.equal(title, "Factory: " + "a".repeat(69)); // partial character dropped, nothing invalid left
    assert.ok(!title.includes("\uFFFD"));
  } finally { cleanup(w); }
});

test("publish: hostile or missing run-log values are reduced to 'unknown'", () => {
  for (const log of ['{"test_result":"PASS; rm -rf / #","review_verdict":"APPROVE\\n**merge me**"}', "not json at all", undefined]) {
    const w = world({ log });
    try {
      publish(w);
      const body = ghArgs(w)[ghArgs(w).indexOf("--body") + 1];
      assert.match(body, /Tests: unknown \| Factory reviewer verdict: unknown/, String(log));
      assert.doesNotMatch(body, /merge me|rm -rf/);
      assert.ok(ghArgs(w).includes("--draft"));
    } finally { cleanup(w); }
  }
});

test("publish: Slack notice is sent only when a token and channel are set", () => {
  let w = world({ log: '{"test_result":"FAIL","review_verdict":"BLOCK"}' });
  try {
    publish(w);
    assert.ok(!existsSync(join(w.root, "slack.payload")), "posted to Slack without a token/channel");
  } finally { cleanup(w); }
  w = world({ log: '{"test_result":"FAIL","review_verdict":"BLOCK"}' });
  try {
    publish(w, { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C1" });
    const payload = JSON.parse(readFileSync(join(w.root, "slack.payload"), "utf8"));
    assert.equal(payload.channel, "C1");
    assert.match(payload.text, /DRAFT; self-reported tests: FAIL, reviewer: BLOCK/);
    assert.match(payload.text, /pull\/9/);
  } finally { cleanup(w); }
});

test("publish: a bundle carrying any other ref is rejected and nothing is pushed", () => {
  const w = world({
    mutateBundle: ({ root, j1, rt1, git }) => {
      // attacker-built bundle that also moves main
      git(j1, "checkout", "-q", "main");
      writeFileSync(join(j1, "pwn"), "pwn");
      git(j1, "add", "-A");
      git(j1, "commit", "-qm", "malicious main");
      git(j1, "bundle", "create", join(rt1, "factory.bundle"), "main", "factory/run-1");
    },
  });
  try {
    assert.throws(() => publish(w), /Unexpected refs in bundle/);
    assert.ok(!remoteHas(w, "refs/heads/factory/run-1"));
    assert.equal(sh(w.remote, "git", ["rev-parse", "main"]).trim(), sh(join(w.root, "base"), "git", ["rev-parse", "main"]).trim());
    assert.ok(!existsSync(join(w.root, "gh.args")), "opened a PR from a rejected bundle");
  } finally { cleanup(w); }
});

test("publish: a truncated bundle fails and nothing is pushed", () => {
  const w = world({
    mutateBundle: ({ rt1 }) => {
      const b = readFileSync(join(rt1, "factory.bundle"));
      writeFileSync(join(rt1, "factory.bundle"), b.subarray(0, 200));
    },
  });
  try {
    assert.throws(() => publish(w));
    assert.ok(!remoteHas(w, "refs/heads/factory/run-1"));
    assert.ok(!existsSync(join(w.root, "gh.args")));
  } finally { cleanup(w); }
});

test("export + publish: work when the run started from a non-default branch (no local main)", () => {
  const w = world({ fromBranch: "release/1.x", log: '{"test_result":"PASS","review_verdict":"APPROVE"}' });
  try {
    const branches = sh(join(w.root, "job1"), "git", ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean);
    assert.ok(!branches.includes("main"), `precondition: no local main, have ${branches}`);
    publish(w);
    assert.ok(remoteHas(w, "refs/heads/factory/run-1"));
    assert.ok(ghArgs(w).includes("--draft"));
  } finally { cleanup(w); }
});

test("publish: commits that touch protected paths are refused, and nothing is pushed or opened", () => {
  const baseFiles = { ".claude/agents/reviewer.md": "reviewer", "CLAUDE.md": "rules", "clyintel/CLAUDE.md": "rules", "scripts/old.mjs": "old" };
  const bad = {
    "settings with hooks": ({ put }) => put(".claude/settings.json", "{}"),
    "edit an agent definition": ({ put }) => put(".claude/agents/reviewer.md", "evil"),
    "nested .claude": ({ put }) => put("clyintel/.claude/settings.json", "{}"),
    "edit root CLAUDE.md": ({ put }) => put("CLAUDE.md", "evil"),
    "edit product CLAUDE.md": ({ put }) => put("clyintel/CLAUDE.md", "evil"),
    "new nested CLAUDE.md": ({ put }) => put("clyintel/lib/CLAUDE.md", "steer"),
    "new CLAUDE.local.md": ({ put }) => put("CLAUDE.local.md", "steer"),
    "new file under scripts/": ({ put }) => put("scripts/evil.mjs", "x"),
    "edit scripts/": ({ put }) => put("scripts/old.mjs", "patched"),
    "new file under api/": ({ put }) => put("api/x.js", "x"),
    "workflow": ({ put }) => put(".github/workflows/x.yml", "x"),
    ".gitignore": ({ put }) => put(".gitignore", "tmp/\n"),
    ".gitattributes (root)": ({ put }) => put(".gitattributes", "* filter=x"),
    ".gitattributes (nested)": ({ put }) => put("clyintel/.gitattributes", "* filter=x"),
    "unicode path git would quote": ({ put }) => put("scripts/\u00e9.js", "x"),
    "weaken the tenant-isolation test": ({ put }) => put("clyintel/tests/tenant-isolation.test.ts", "// emptied"),
    "weaken the agent-isolation test": ({ put }) => put("clyintel/lib/outreach/agent-isolation.test.ts", "// emptied"),
    "tenant-isolation helper": ({ put }) => put("clyintel/tests/tenant-isolation.helpers.ts", "x"),
    "vercel.json (crons)": ({ put }) => put("clyintel/vercel.json", "{}"),
    "vercel.ts": ({ put }) => put("clyintel/vercel.ts", "export const config = {}"),
    ".vercelignore": ({ put }) => put(".vercelignore", "x"),
    "case-variant .Claude/ dir": ({ put }) => put(".Claude/settings.json", "{}"),
    "case-variant Claude.md": ({ put }) => put("clyintel/lib/Claude.md", "steer"),
    "case-variant .Mcp.json": ({ put }) => put(".Mcp.json", "{}"),
    "husky hook": ({ put }) => put("clyintel/.husky/pre-commit", "x"),
    "vscode task": ({ put }) => put(".vscode/tasks.json", "{}"),
    "devcontainer": ({ put }) => put(".devcontainer/devcontainer.json", "{}"),
    "auth middleware": ({ put }) => put("clyintel/middleware.ts", "export {}"),
    "next 16 proxy": ({ put }) => put("clyintel/proxy.ts", "export {}"),
    "root CODEOWNERS": ({ put }) => put("CODEOWNERS", "* @someone"),
    "docs/CODEOWNERS": ({ put }) => put("docs/CODEOWNERS", "* @someone"),
    "root vercel.json": ({ put }) => put("vercel.json", "{}"),
    "next.config": ({ put }) => put("clyintel/next.config.ts", "export default {}"),
    "schema migration": ({ put }) => put("clyintel/schema/099_new.sql", "alter table x;"),
    "root schema dir": ({ put }) => put("schema/099_new.sql", "alter table x;"),
    "weaken env-config test": ({ put }) => put("clyintel/lib/config/env-config.test.ts", "// emptied"),
    "test stubs": ({ put }) => put("clyintel/test/stubs/server-only.ts", "x"),
    "force-added .env": ({ put }) => put(".env", "ANTHROPIC_API_KEY=x"),
    "nested .env.local": ({ put }) => put("clyintel/.env.local", "x"),
    "supabase migrations": ({ put }) => put("clyintel/supabase/migrations/001_x.sql", "alter table x;"),
    "vitest config": ({ put }) => put("clyintel/vitest.config.ts", "export default {}"),
    ".gitmodules": ({ put }) => put(".gitmodules", "[submodule \"x\"]"),
    "product context .ai/": ({ put }) => put(".ai/specs/new.md", "steer"),
    "nested .ai/": ({ put }) => put("clyintel/.ai/context.md", "steer"),
    "root .mcp.json": ({ put }) => put(".mcp.json", "{}"),
    "nested .mcp.json": ({ put }) => put("clyintel/.mcp.json", "{}"),
    "delete a protected file": ({ git }) => git("rm", "-q", ".claude/agents/reviewer.md"),
    "rename out of a protected dir": ({ git, put }) => { put("clyintel/moved.md", "reviewer"); git("rm", "-q", ".claude/agents/reviewer.md"); },
  };
  for (const [name, edit] of Object.entries(bad)) {
    const w = world({ baseFiles, edit });
    try {
      assert.throws(() => publish(w), /protected paths/, name);
      assert.ok(!remoteHas(w, "refs/heads/factory/run-1"), `${name}: pushed anyway`);
      assert.ok(!existsSync(join(w.root, "gh.args")), `${name}: opened a PR anyway`);
    } finally { cleanup(w); }
  }
});

test("publish: ordinary app, test and run-log changes are allowed", () => {
  const baseFiles = { ".claude/agents/reviewer.md": "reviewer", "CLAUDE.md": "rules" };
  const w = world({
    baseFiles,
    log: '{"test_result":"PASS","review_verdict":"APPROVE"}',
    edit: ({ put }) => {
      put("clyintel/app/page.tsx", "page");
      put("clyintel/lib/charge.ts", "charge");
      put("clyintel/tests/new.test.ts", "t");
      put("clyintel/scripts/seed.ts", "lookalike of scripts/, not the factory's"); // not top-level
      put("clyintel/api/route.ts", "lookalike of api/, not the Slack endpoint");
      put("clyintel/.github-notes.md", "n");
    },
  });
  try {
    publish(w);
    assert.ok(remoteHas(w, "refs/heads/factory/run-1"));
    assert.ok(ghArgs(w).includes("--draft"));
  } finally { cleanup(w); }
});

test("publish: symlinks and submodules are refused, deleting one is not", () => {
  const cases = {
    "symlink out of the repo": ({ j1, put }) => { put("clyintel/public/.keep"); symlinkSync("/proc/self/environ", join(j1, "clyintel/public/env.txt")); },
    "gitlink (nested repo)": ({ j1 }) => {
      const sub = join(j1, "vendor/sub");
      mkdirSync(sub, { recursive: true });
      sh(sub, "git", ["init", "-q"]);
      writeFileSync(join(sub, "f"), "x");
      sh(sub, "git", ["add", "f"]);
      sh(sub, "git", ["commit", "-qm", "sub"]);
    },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const w = world({ edit });
    try {
      assert.throws(() => publish(w), /symlinks or submodules/, name);
      assert.ok(!remoteHas(w, "refs/heads/factory/run-1"), `${name}: pushed anyway`);
      assert.ok(!existsSync(join(w.root, "gh.args")), `${name}: opened a PR anyway`);
    } finally { cleanup(w); }
  }
  // a base with a symlink that the factory deletes is fine
  const w = world({ baseLink: "link", edit: ({ git }) => git("rm", "-q", "link") });
  try {
    publish(w);
    assert.ok(remoteHas(w, "refs/heads/factory/run-1"));
  } finally { cleanup(w); }
});

test("publish: dependency and config changes are allowed but flagged in the PR body", () => {
  const w = world({
    log: '{"test_result":"PASS","review_verdict":"APPROVE"}',
    edit: ({ put }) => {
      put("clyintel/package.json", "{}");
      put("clyintel/package-lock.json", "{}");
      put("clyintel/tsconfig.json", "{}");
      put("clyintel/lib/stray.sql", "select 1;");
      put("clyintel/lib/settlement/charge.ts", "x");
      put("clyintel/lib/stripe.ts", "x");
      put("clyintel/app/api/sms-reply/route.ts", "x");
      put("clyintel/lib/demo-mode.ts", "x");
      put("clyintel/instrumentation.ts", "x");
      put("lib/supabase.ts", "x");
      put("clyintel/lib/providers/paypal.ts", "x");
      put("clyintel/app/api/connect/onboard/route.ts", "x");
      put("clyintel/app/api/stripe-webhook/route.ts", "x");
      put("clyintel/.npmrc", "x");
      put("clyintel/lib/.gitignore", "x");
      put("clyintel/app/page.tsx", "page");
      put("clyintel/lib/we`ird ```name.ts", "x"); // not sensitive; just proves odd names don't break anything
    },
  });
  try {
    publish(w);
    assert.ok(remoteHas(w, "refs/heads/factory/run-1"));
    const body = ghArgs(w)[ghArgs(w).indexOf("--body") + 1];
    assert.match(body, /Touches sensitive files/);
    for (const f of ["clyintel/package.json", "clyintel/package-lock.json", "clyintel/tsconfig.json", "clyintel/lib/stray.sql", "clyintel/lib/settlement/charge.ts", "clyintel/lib/stripe.ts", "clyintel/app/api/sms-reply/route.ts", "clyintel/lib/demo-mode.ts", "clyintel/instrumentation.ts", "lib/supabase.ts", "clyintel/lib/providers/paypal.ts", "clyintel/app/api/connect/onboard/route.ts", "clyintel/app/api/stripe-webhook/route.ts", "clyintel/.npmrc", "clyintel/lib/.gitignore"]) assert.ok(body.includes(f), f);
    assert.ok(!body.includes("app/page.tsx"), "ordinary files must not be listed as sensitive");
  } finally { cleanup(w); }
});

test("publish: sensitive file names from the agent cannot inject markup or break the code fence", () => {
  const w = world({
    edit: ({ put }) => {
      put("clyintel/tsconfig.json", "x");
      put("clyintel/a`b/package.json", "x"); // backtick in the directory name
      put("clyintel/<img src=x>/package.json", "x");
    },
  });
  try {
    publish(w);
    const body = ghArgs(w)[ghArgs(w).indexOf("--body") + 1];
    const fence = body.slice(body.indexOf("Touches sensitive files"));
    assert.equal((fence.match(/```/g) || []).length, 2, "exactly one opening and one closing fence");
    assert.doesNotMatch(fence, /<img|a`b/);
    assert.match(fence, /a\?b\/package\.json/);
  } finally { cleanup(w); }
});

test("publish: pushes ONE commit of the checked tree, so a committed-then-deleted secret never reaches GitHub", () => {
  const w = world({
    edit: ({ put, git, j1 }) => {
      put("leak.env", "ANTHROPIC_API_KEY=sk-ant-SECRET");
      git("add", "-A");
      git("commit", "-qm", "oops");
      git("rm", "-q", "leak.env");
      put("clyintel/lib/ok.ts", "ok");
    },
  });
  try {
    publish(w);
    const base = sh(w.j2, "git", ["rev-parse", "HEAD"]).trim();
    const commits = sh(w.remote, "git", ["rev-list", "--count", `${base}..refs/heads/factory/run-1`]).trim();
    assert.equal(commits, "1", "history must be squashed to a single commit");
    const allText = sh(w.remote, "git", ["log", "-p", "--all"]);
    assert.doesNotMatch(allText, /sk-ant-SECRET/);
    assert.equal(sh(w.remote, "git", ["cat-file", "-t", "refs/heads/factory/run-1:clyintel/lib/ok.ts"]).trim(), "blob");
  } finally { cleanup(w); }
});

test("publish: modified or deleted existing tests are flagged; new tests and app files are not", () => {
  const w = world({
    baseFiles: { "clyintel/lib/a.test.ts": "a", "clyintel/lib/b.spec.tsx": "b", "clyintel/lib/keep.test.ts": "k" },
    edit: ({ put, git }) => {
      put("clyintel/lib/a.test.ts", "weakened");
      git("rm", "-q", "clyintel/lib/b.spec.tsx");
      put("clyintel/lib/new.test.ts", "new");
      put("clyintel/package.json", "{}"); // so both notes appear together
    },
  });
  try {
    publish(w);
    const body = ghArgs(w)[ghArgs(w).indexOf("--body") + 1];
    assert.match(body, /Modifies or deletes existing tests/);
    assert.match(body, /Touches sensitive files/);
    const tests = body.slice(body.indexOf("Modifies or deletes existing tests"));
    assert.ok(tests.includes("clyintel/lib/a.test.ts") && tests.includes("clyintel/lib/b.spec.tsx"));
    assert.ok(!tests.includes("new.test.ts") && !tests.includes("keep.test.ts"), "new/untouched tests must not be flagged");
  } finally { cleanup(w); }
});

test("publish: re-running publish after a successful push rebuilds the same commit (push is a no-op, PR is retried)", () => {
  const w = world({ edit: ({ put }) => put("clyintel/lib/ok.ts", "ok") });
  try {
    publish(w);
    const first = sh(w.remote, "git", ["rev-parse", "refs/heads/factory/run-1"]).trim();
    rmSync(join(w.root, "gh.args"));
    // a fresh runner checkout of the base commit, at a different wall-clock time
    sh(w.root, "git", ["clone", "-q", "--no-local", `file://${w.remote}`, "job3"]);
    sh(join(w.root, "job3"), "git", ["checkout", "-q", sh(w.j2, "git", ["rev-parse", "HEAD"]).trim()]);
    publish({ ...w, j2: join(w.root, "job3") }, { GIT_AUTHOR_DATE: "2031-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2031-01-01T00:00:00Z" });
    assert.equal(sh(w.remote, "git", ["rev-parse", "refs/heads/factory/run-1"]).trim(), first, "re-run produced a different commit");
    assert.ok(existsSync(join(w.root, "gh.args")), "PR creation was not retried");
  } finally { cleanup(w); }
});

test("publish: no sensitive files means no warning section", () => {
  const w = world({ edit: ({ put }) => put("clyintel/app/page.tsx", "page") });
  try {
    publish(w);
    assert.doesNotMatch(ghArgs(w)[ghArgs(w).indexOf("--body") + 1], /Touches sensitive files|existing tests/);
  } finally { cleanup(w); }
});

test("publish: a refusal logs only indented names (no line can look like a workflow command)", () => {
  const w = world({ edit: ({ put }) => put("scripts/::add-mask::secret.mjs", "x") });
  try {
    let stderr = "";
    try { publish(w); } catch (e) { stderr = String(e.stderr || e.message); }
    assert.match(stderr, /refusing to push/);
    assert.ok(stderr.split("\n").every((l) => !l.startsWith("::")), "a log line starts with ::");
    assert.match(stderr, /^    - scripts\/::add-mask::secret\.mjs$/m);
  } finally { cleanup(w); }
});

test("publish: logs what is about to be pushed, indented", () => {
  const w = world({ edit: ({ put }) => put("clyintel/lib/charge.ts", "x") });
  try {
    const out = publish(w);
    assert.match(out, /What this run will push/);
    assert.match(out, /^    .*clyintel\/lib\/charge\.ts/m);
  } finally { cleanup(w); }
});

test("notify-failure: fixed message, only with a token and channel, never the brief or paths", () => {
  const run = (env) => {
    const root = mkdtempSync(join(tmpdir(), "nf-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/bash\nfor a in "$@"; do case "$a" in \\{*) printf '%s' "$a" > "${root}/payload";; esac; done\n`);
    chmodSync(join(bin, "curl"), 0o755);
    try {
      execFileSync("bash", ["-e", "-c", stepScript("Tell Slack the run failed", {})], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUN_URL: "https://github.com/x/y/actions/runs/1", ...env }, stdio: "pipe",
      });
      return existsSync(join(root, "payload")) ? JSON.parse(readFileSync(join(root, "payload"), "utf8")) : null;
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  assert.equal(run({ SLACK_BOT_TOKEN: "", SLACK_CHANNEL: "C1", PIPELINE_RESULT: "success" }), null);
  assert.equal(run({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL: "", PIPELINE_RESULT: "success" }), null);
  const pub = run({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL: "C1", PIPELINE_RESULT: "success", BRIEF: "secret brief", BAD: "scripts/x" });
  assert.equal(pub.channel, "C1");
  assert.match(pub.text, /publishing/);
  assert.match(pub.text, /actions\/runs\/1/);
  assert.doesNotMatch(pub.text, /secret brief|scripts\/x/);
  assert.match(run({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL: "C1", PIPELINE_RESULT: "failure" }).text, /agent job/);
  assert.match(run({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL: "C1", PIPELINE_RESULT: "success", PUBLISH_RESULT: "cancelled" }).text, /cancelled or timed out/);
  assert.match(run({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL: "C1", PIPELINE_RESULT: "cancelled" }).text, /cancelled or timed out/);
  assert.match(run({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL: "C1", PIPELINE_RESULT: "skipped" }).text, /switched off.*D3_FACTORY_ENABLED/);
});

test("workflow: notify-failure runs on either job failing and holds no permissions", () => {
  assert.match(WORKFLOW, /notify-failure:\n\s+needs: \[pipeline, publish\]\n\s+if: \$\{\{ always\(\) && \(needs\.pipeline\.result == 'failure' \|\| needs\.publish\.result == 'failure' \|\| needs\.pipeline\.result == 'skipped' \|\| needs\.pipeline\.result == 'cancelled' \|\| needs\.publish\.result == 'cancelled'\) \}\}/);
  assert.match(WORKFLOW, /notify-failure:[\s\S]*?permissions: \{\}/);
  // kill switch: the agent job only runs when the repo variable is exactly 'true'
  assert.match(WORKFLOW, /\n  pipeline:\n\s+(#.*\n\s+)*if: \$\{\{ vars\.D3_FACTORY_ENABLED == 'true' && github\.ref == 'refs\/heads\/main' \}\}/);
});

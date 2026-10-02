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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, copyFileSync } from "node:fs";
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
function world({ log, mutateBundle, fromBranch, baseFiles = {}, edit } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pub-"));
  const git = (cwd, ...a) => sh(cwd, "git", a);
  git(root, "init", "-q", "-b", "main", "base");
  writeFileSync(join(root, "base/f"), "base");
  for (const [rel, body] of Object.entries(baseFiles)) {
    mkdirSync(dirname(join(root, "base", rel)), { recursive: true });
    writeFileSync(join(root, "base", rel), body);
  }
  git(join(root, "base"), "add", "-A");
  git(join(root, "base"), "commit", "-qm", "base");
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
  git(root, "clone", "-q", ...cloneArgs, "--no-local", `file://${join(root, "remote.git")}`, "job2");
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
    assert.match(body, /Tests: PASS \| Factory reviewer verdict: APPROVE/);
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

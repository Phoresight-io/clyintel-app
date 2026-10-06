// Run with: node --test scripts/agent-isolation.test.mjs
//
// The agent job's isolation, as the workflow defines it:
//   - which job holds which secret (the job that runs agents holds exactly one),
//   - the exact `docker run` the agent step and the commit/bundle step issue (via a stub docker),
//   - and, when a sandbox image is available, the real thing: the step is run with real docker
//     while a host process holds decoy secrets, and a probe inside the container reports what it
//     can see. Set D3_SANDBOX_TEST_IMAGE to an image with node and git (the workflow's AGENT_IMAGE
//     works; any node:22 image with git does) to run those; they are skipped otherwise.
// Nothing here starts an agent session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/d3-factory.yml"), "utf8");
const AGENT_STEP = "Run pipeline in the agent container (Planner → Coder → Tester → Reviewer)";
const COMMIT_STEP = "Commit and bundle the agents' work (container, no secrets, no network)";
const CLEANUP_STEP = "Remove the agents' containers and working tree";
const COPY_STEP = "Copy the repo for the agents";
const USER_STEP = "Prepare the agent container's user entry";
const KEY = "D3_FACTORY_ANTHROPIC_API_KEY";

// ---- workflow structure

const JOBS = ["prepare", "notify-start", "pipeline", "publish", "notify-failure"];
function job(name) {
  const i = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(i >= 0, `job ${name} not found`);
  const next = JOBS.map((j) => WORKFLOW.indexOf(`\n  ${j}:\n`)).filter((k) => k > i).sort((a, b) => a - b)[0] ?? WORKFLOW.length;
  return WORKFLOW.slice(i, next);
}
const secretsOf = (text) => new Set([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
const codeOnly = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

// The `run: |` script of a step, as the runner would see it (expressions left in place unless replaced).
function stepScript(name, subs = {}) {
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
// A single-line `run:` (the cleanup step).
function stepRunLine(name) {
  const lines = WORKFLOW.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const r = lines.findIndex((l, k) => k > i && /^\s+run: \S/.test(l));
  return lines[r].replace(/^\s+run: /, "");
}

test("workflow: the job that runs agents references exactly one secret, the dedicated key", () => {
  assert.deepEqual([...secretsOf(codeOnly(job("pipeline")))], [KEY]);
  // and only the container step gets it
  const pipeline = codeOnly(job("pipeline"));
  assert.equal(pipeline.split(`secrets.${KEY}`).length - 1, 1);
  const step = pipeline.slice(pipeline.indexOf(`- name: ${AGENT_STEP}`));
  assert.ok(step.indexOf(`secrets.${KEY}`) < step.indexOf("- name:", 10), "the key belongs to the agent-container step");
  assert.doesNotMatch(pipeline, /GITHUB_TOKEN|github\.token|SLACK_BOT_TOKEN|RUN_LOG_SHEET_WEBHOOK|SLACK_CHANNEL/);
  assert.match(job("pipeline"), /permissions:\n\s+contents: read/);
});

test("workflow: there is no fallback to the shared ANTHROPIC_API_KEY anywhere in the factory", () => {
  assert.doesNotMatch(codeOnly(WORKFLOW), /secrets\.ANTHROPIC_API_KEY\b/);
  assert.doesNotMatch(codeOnly(WORKFLOW), /\|\|\s*secrets\./); // no `a || b` secret fallbacks at all
});

test("workflow: Slack and the Sheet webhook live only in jobs that never execute agent code", () => {
  const holders = { "notify-start": ["SLACK_BOT_TOKEN"], publish: ["SLACK_BOT_TOKEN", "RUN_LOG_SHEET_WEBHOOK"], "notify-failure": ["SLACK_BOT_TOKEN", "RUN_LOG_SHEET_WEBHOOK"] };
  for (const name of JOBS) {
    const secrets = secretsOf(codeOnly(job(name)));
    for (const s of ["SLACK_BOT_TOKEN", "RUN_LOG_SHEET_WEBHOOK"]) {
      assert.equal(secrets.has(s), (holders[name] ?? []).includes(s), `${name} / ${s}`);
    }
  }
  for (const name of Object.keys(holders)) {
    const text = codeOnly(job(name));
    // never runs the factory's or the agents' code: no node/npm, no orchestrator, no containers, and
    // it checks out nothing but the trusted base commit (publish) or nothing at all
    assert.doesNotMatch(text, /d3-orchestrator|\bnpm\b|\bnpx\b|\bnode\b|setup-node|docker|bash -c "\$|source |\. \.\//, name);
    const refs = [...text.matchAll(/ref: (.+)/g)].map((m) => m[1].trim());
    assert.ok(refs.every((r) => r.startsWith("${{ needs.prepare.outputs.base_sha }}")), `${name} checks out ${refs}`);
  }
  assert.match(job("notify-start"), /permissions: \{\}/);
  assert.match(job("notify-failure"), /permissions: \{\}/);
});

test("workflow: the sandbox image is pinned by digest, and every step after the agents ran is containerised or cannot run agent code", () => {
  assert.match(job("pipeline"), /AGENT_IMAGE: node:22-bookworm@sha256:[0-9a-f]{64}\n/);
  const pipeline = codeOnly(job("pipeline"));
  const after = pipeline.slice(pipeline.indexOf(`- name: ${AGENT_STEP}`));
  // the steps after the agents: the agent container, the commit container, the upload, the cleanup
  const names = [...after.matchAll(/- (?:name: (.+)|uses: (.+))/g)].map((m) => (m[1] ?? m[2]).trim());
  assert.deepEqual(names, [AGENT_STEP, COMMIT_STEP, "actions/upload-artifact@v4", CLEANUP_STEP]);
  assert.match(after, /path: \$\{\{ runner\.temp \}\}\/factory\.bundle/);
  // no host step runs git (or anything else) in the workspace once agents have run
  const hostRuns = [stepScript(AGENT_STEP), stepScript(COMMIT_STEP), stepScript(CLEANUP_STEP)].join("\n").split("\n")
    .filter((l) => /^\s*git\b/.test(l));
  assert.deepEqual(hostRuns, []);
});

test("workflow: the agents work on a copy outside the checkout, so the checkout's post-job git never sees their .git", () => {
  const pipeline = codeOnly(job("pipeline"));
  const copy = pipeline.indexOf(`- name: ${COPY_STEP}`);
  assert.ok(copy > pipeline.indexOf("actions/checkout@v4") && copy < pipeline.indexOf("npm ci"), "copy right after checkout, before installs");
  assert.match(stepScript(COPY_STEP), /cp -a "\$GITHUB_WORKSPACE\/\." "\$AGENT_REPO\/"/);
  // after the copy, nothing uses the checkout: no step works in it, mounts it, or runs there by default
  const after = pipeline.slice(pipeline.indexOf("\n      - ", copy + 1));
  assert.doesNotMatch(after, /GITHUB_WORKSPACE/);
  const steps = after.split(/\n      - /).slice(1);
  for (const st of steps) {
    if (/^uses: actions\/upload-artifact/.test(st)) continue;
    // a run step either cds into / works in the agents' copy, or touches no repo files at all
    assert.ok(/d3-agent-repo|docker run --rm --network none|bundle-out|d3-etc/.test(st), `step does not say where it works:\n${st.slice(0, 200)}`);
  }
});

// ---- the docker invocations, with a stub docker that records them

// Runs a step script with a stub `docker` (and a stub `id` that reports the hosted runner's uid 1001).
// The stub writes its argv and, for every `-e NAME` (no value), what the container would receive.
function withStubDocker(script, env, { bundle = "file" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "iso-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const ws = join(root, "workspace");
  const rt = join(root, "runner_temp");
  mkdirSync(ws);
  mkdirSync(rt);
  writeFileSync(join(bin, "id"), `#!/bin/bash\ncase "$1" in -u|-g) echo 1001;; *) echo "uid=1001";; esac\n`);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
printf '%s\\0' "$@" >> "${root}/docker.calls"; echo >> "${root}/docker.calls"
case "$1" in rm) exit 0;; esac
case "\${@: -1}" in
  /etc/passwd) printf 'root:x:0:0:root:/root:/bin/bash\\nnode:x:1000:1000::/home/node:/bin/bash\\n'; exit 0;;
  /etc/group) printf 'root:x:0:\\nnode:x:1000:\\n'; exit 0;;
esac
printf '%s\\0' "$@" > "${root}/docker.argv"
: > "${root}/docker.env"
prev=""
for a in "$@"; do
  if [ "$prev" = "-e" ]; then
    case "$a" in
      *=*) printf '%s\\0' "$a" >> "${root}/docker.env" ;;
      *) if [ -n "\${!a+x}" ]; then printf '%s=%s\\0' "$a" "\${!a}" >> "${root}/docker.env"; fi ;;
    esac
  fi
  if [ "$prev" = "-v" ]; then
    case "$a" in *:/out)
      out="\${a%:/out}"
      case "${bundle}" in
        file) printf 'bundle' > "$out/factory.bundle" ;;
        link) ln -s /etc/hostname "$out/factory.bundle" ;;
        none) ;;
      esac ;;
    esac
  fi
  prev="$a"
done
`
  );
  chmodSync(join(bin, "id"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync("bash", ["-e", "-c", script], {
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: ws, RUNNER_TEMP: rt, ...env },
    encoding: "utf8",
  });
  const argv = existsSync(join(root, "docker.argv")) ? readFileSync(join(root, "docker.argv"), "utf8").split("\0").slice(0, -1) : null;
  const cenv = existsSync(join(root, "docker.env"))
    ? Object.fromEntries(readFileSync(join(root, "docker.env"), "utf8").split("\0").slice(0, -1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]))
    : null;
  const calls = existsSync(join(root, "docker.calls")) ? readFileSync(join(root, "docker.calls"), "utf8").split("\0\n").filter(Boolean).map((l) => l.split("\0")) : [];
  return { code: r.status, stderr: r.stderr, argv, cenv, calls, ws, rt, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const flagValues = (argv, flag) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
// Host env a real runner job would have, including secrets that must NOT reach the container.
const DECOYS = {
  SLACK_BOT_TOKEN: "xoxb-DECOY", RUN_LOG_SHEET_WEBHOOK: "https://hook.DECOY", GITHUB_TOKEN: "ghs_DECOY",
  ACTIONS_RUNTIME_TOKEN: "DECOY-runtime", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "DECOY-oidc", ANTHROPIC_API_KEY: "sk-shared-DECOY",
  GITHUB_ENV: "/runner/_temp/env", GITHUB_PATH: "/runner/_temp/path",
};
const RUN_ENV = {
  ...DECOYS,
  [KEY]: "sk-d3-REAL", BRIEF: "add a reminder", SLACK_USER: "U1", BRANCH: "factory/run-9",
  GITHUB_RUN_ID: "9", GITHUB_REPOSITORY: "x/y", GITHUB_ACTOR: "charles", AGENT_IMAGE: "img@sha256:abc",
};

test("agent container: only the repo is mounted, no privileges, and the environment is exactly the allowlist", () => {
  const r = withStubDocker(stepScript(AGENT_STEP), RUN_ENV);
  try {
    assert.equal(r.code, 0, r.stderr);
    const { argv, cenv } = r;
    assert.equal(argv[0], "run");
    // exactly these variables reach the container; the key is the only secret
    assert.deepEqual(Object.keys(cenv).sort(), [
      "BRANCH", "BRIEF", "CI", KEY, "D3_FACTORY_SANDBOX", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "HOME", "LANG", "SLACK_USER", "TMPDIR",
    ]);
    assert.equal(cenv[KEY], "sk-d3-REAL");
    assert.equal(cenv.D3_FACTORY_SANDBOX, "container");
    for (const v of Object.values(DECOYS)) assert.ok(!Object.values(cenv).includes(v), `decoy ${v} reached the container`);
    // the key is passed by NAME: its value is never on docker's command line (visible in ps)
    assert.ok(!argv.some((a) => a.includes("sk-d3-REAL")));
    assert.ok(flagValues(argv, "-e").includes(KEY));
    // mounts: the agents' copy (NOT the checkout) at /work/repo, and read-only passwd/group
    assert.deepEqual(flagValues(argv, "-v"), [`${r.rt}/d3-agent-repo:/work/repo`, `${r.rt}/d3-etc/passwd:/etc/passwd:ro`, `${r.rt}/d3-etc/group:/etc/group:ro`]);
    assert.ok(!argv.some((a) => a.includes(r.ws)), "the checkout is mounted");
    assert.deepEqual(flagValues(argv, "--name"), ["d3-agents-9"]);
    assert.ok(!argv.some((a) => a.startsWith("--mount") || a.startsWith("--volume")));
    assert.equal(flagValues(argv, "--workdir")[0], "/work/repo/scripts");
    // non-root, no capabilities, no privilege escalation, read-only root, private tmp
    assert.deepEqual(flagValues(argv, "--user"), ["1001:1001"]);
    assert.deepEqual(flagValues(argv, "--cap-drop"), ["ALL"]);
    assert.deepEqual(flagValues(argv, "--security-opt"), ["no-new-privileges"]);
    assert.ok(argv.includes("--read-only") && argv.includes("--rm") && argv.includes("--init"));
    assert.match(flagValues(argv, "--tmpfs")[0], /^\/tmp:/);
    assert.ok(flagValues(argv, "--pids-limit").length === 1);
    assert.deepEqual(flagValues(argv, "--network"), ["bridge"]);
    // nothing that would hand the container the host
    for (const a of argv) {
      assert.doesNotMatch(a, /docker\.sock|^--privileged|^--env-file|^--pid(=|$)|^--ipc|^--uts|^--userns|^--cap-add|^--device|^--group-add|unconfined|^--volumes-from/, a);
    }
    assert.deepEqual(argv.slice(-3), ["img@sha256:abc", "node", "d3-orchestrator.mjs"]);
  } finally { r.done(); }
});

test("agent container: refuses to start (and never calls docker) without the dedicated key, even with ANTHROPIC_API_KEY set", () => {
  for (const key of [undefined, "", "   \n"]) {
    const env = { ...RUN_ENV };
    if (key === undefined) delete env[KEY]; else env[KEY] = key;
    const r = withStubDocker(stepScript(AGENT_STEP), env);
    try {
      assert.notEqual(r.code, 0);
      assert.equal(r.argv, null, "docker was called");
      assert.match(r.stderr, /D3_FACTORY_ANTHROPIC_API_KEY is not set.*no fallback to ANTHROPIC_API_KEY/);
      assert.doesNotMatch(r.stderr, /DECOY/);
    } finally { r.done(); }
  }
});

test("commit container: no secrets, no network, and only the workspace and a fresh output dir mounted", () => {
  const env = { ...RUN_ENV, RUN_ID: "9", BASE_SHA: "a".repeat(40), BUNDLE_OUT: "/out", COMMIT_AND_BUNDLE: "git bundle create ..." };
  const r = withStubDocker(stepScript(COMMIT_STEP), env);
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.keys(r.cenv).sort(), ["BASE_SHA", "BUNDLE_OUT", "COMMIT_AND_BUNDLE", "HOME", "RUN_ID"]);
    assert.ok(!r.argv.some((a) => a.includes("sk-d3-REAL") || a.includes("DECOY")));
    assert.deepEqual(flagValues(r.argv, "--network"), ["none"]);
    assert.deepEqual(flagValues(r.argv, "-v"), [`${r.rt}/d3-agent-repo:/work/repo`, `${r.rt}/bundle-out:/out`, `${r.rt}/d3-etc/passwd:/etc/passwd:ro`, `${r.rt}/d3-etc/group:/etc/group:ro`]);
    assert.deepEqual(flagValues(r.argv, "--name"), ["d3-commit-9"]);
    assert.deepEqual(flagValues(r.argv, "--cap-drop"), ["ALL"]);
    assert.deepEqual(flagValues(r.argv, "--user"), ["1001:1001"]);
    assert.ok(r.argv.includes("--read-only"));
    // the script is passed by name and run by bash inside the container, never interpolated on the host
    assert.deepEqual(r.argv.slice(-6), ["img@sha256:abc", "bash", "-euo", "pipefail", "-c", "git bundle create ..."]);
    assert.equal(readFileSync(join(r.rt, "factory.bundle"), "utf8"), "bundle");
  } finally { r.done(); }
});

test("commit container: a bundle that is a symlink, or missing, is refused and nothing is uploaded", () => {
  for (const mode of ["link", "none"]) {
    const env = { RUN_ID: "9", BASE_SHA: "a".repeat(40), BUNDLE_OUT: "/out", COMMIT_AND_BUNDLE: "true", AGENT_IMAGE: "img" };
    const r = withStubDocker(stepScript(COMMIT_STEP), env, { bundle: mode });
    try {
      assert.notEqual(r.code, 0, mode);
      assert.match(r.stderr, /did not produce a regular file/);
      assert.ok(!existsSync(join(r.rt, "factory.bundle")), mode);
    } finally { r.done(); }
  }
});

test("cleanup: kills both containers, then removes the agents' copy even if the coder locked it, never following links", () => {
  const r = withStubDocker("true", {}); // just for the stub and dirs
  try {
    const repo = join(r.rt, "d3-agent-repo");
    const keep = join(r.root, "keep");
    mkdirSync(join(repo, ".git/objects"), { recursive: true });
    mkdirSync(keep);
    writeFileSync(join(keep, "precious"), "x");
    writeFileSync(join(repo, ".git/config"), "[core]\n\tfsmonitor = /evil");
    symlinkSync(keep, join(repo, "link-out"));
    chmodSync(join(repo, ".git/objects"), 0o500);
    chmodSync(join(repo, ".git"), 0o500); // what a coder could do to survive a plain rm -rf
    const out = spawnSync("bash", ["-e", "-c", stepScript(CLEANUP_STEP)], {
      env: { PATH: `${join(r.root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: r.rt, GITHUB_RUN_ID: "9" }, encoding: "utf8",
    });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!existsSync(repo), "the agents' copy is still there");
    assert.equal(readFileSync(join(keep, "precious"), "utf8"), "x");
    const calls = readFileSync(join(r.root, "docker.calls"), "utf8").split("\0\n").filter(Boolean).map((l) => l.split("\0"));
    assert.deepEqual(calls.find((c) => c[0] === "rm"), ["rm", "-f", "d3-agents-9", "d3-commit-9"]);
    assert.match(job("pipeline"), new RegExp(`- name: ${CLEANUP_STEP}\\n\\s+if: always\\(\\)`));
  } finally { r.done(); }
});

test("user entry: the runner's uid gets a passwd/group entry, read-only, built from the pinned image's own files", () => {
  const r = withStubDocker(stepScript(USER_STEP), { AGENT_IMAGE: "img@sha256:abc" });
  try {
    assert.equal(r.code, 0, r.stderr);
    const passwd = readFileSync(join(r.rt, "d3-etc/passwd"), "utf8");
    assert.match(passwd, /^root:x:0:0:/m);
    assert.match(passwd, /^d3agent:x:1001:1001:d3 factory agents:\/tmp:\/bin\/bash$/m);
    assert.match(readFileSync(join(r.rt, "d3-etc/group"), "utf8"), /^d3agent:x:1001:$/m);
    for (const c of r.calls) assert.ok(c.includes("--network") && c.includes("none"), c.join(" "));
  } finally { r.done(); }
});

// ---- the real container (opt-in: needs docker and D3_SANDBOX_TEST_IMAGE)

const IMAGE = process.env.D3_SANDBOX_TEST_IMAGE;
const dockerUp = !!IMAGE && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const real = dockerUp ? test : test.skip;

// What the agents could see, reported from inside the container by a stand-in "orchestrator".
const PROBE = `
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { strayPids } from "./agent-env.mjs";
// a leftover background process, like a coder's setsid loop; the orchestrator's sweep must kill it
const stray = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
stray.unref();
await new Promise((r) => setTimeout(r, 200));
const strayBefore = fs.existsSync("/proc/" + stray.pid);
for (const pid of strayPids(fs.readdirSync("/proc"), new Set([1, process.pid]))) { try { process.kill(pid, "SIGKILL"); } catch {} }
await new Promise((r) => setTimeout(r, 200));
let strayAfter = false; try { strayAfter = !fs.readFileSync("/proc/" + stray.pid + "/stat", "utf8").includes(") Z "); } catch {}
let user = null; try { user = os.userInfo().username; } catch (e) { user = "ERR " + e.code; }
const tryRead = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; } };
const pids = fs.readdirSync("/proc").filter((d) => /^\\d+$/.test(d));
const environs = pids.map((p) => tryRead("/proc/" + p + "/environ")).filter((x) => x !== null);
let rootWritable = true; try { fs.writeFileSync("/etc/x", "x"); } catch { rootWritable = false; }
const status = tryRead("/proc/self/status") || "";
console.log(JSON.stringify({
  uid: process.getuid(),
  envKeys: Object.keys(process.env).sort(),
  key: process.env.D3_FACTORY_ANTHROPIC_API_KEY,
  decoyInAnyProc: environs.some((e) => e.includes("HOST-ONLY-DECOY")),
  procCount: pids.length,
  comms: pids.map((p) => (tryRead("/proc/" + p + "/comm") || "").trim()),
  dockerSock: fs.existsSync("/var/run/docker.sock") || fs.existsSync("/run/docker.sock"),
  rootWritable,
  hostTempVisible: fs.existsSync(process.env.PROBE_HOST_TEMP || "/nonexistent-host-path"),
  capEff: (status.match(/^CapEff:\\s*(\\S+)/m) || [])[1],
  noNewPrivs: (status.match(/^NoNewPrivs:\\s*(\\S+)/m) || [])[1],
  repoVisible: fs.existsSync("/work/repo/scripts/d3-orchestrator.mjs"),
  pid1: (tryRead("/proc/1/comm") || "").trim(),
  user, strayBefore, strayAfter,
}));
`;

real("REAL container: the agents see the repo and the key, and nothing of the runner (env, processes, files, docker)", async () => {
  const root = mkdtempSync(join(tmpdir(), "real-"));
  const rt = join(root, "runner_temp");
  const ws = join(rt, "d3-agent-repo"); // the agents' copy, as the Copy step makes it
  mkdirSync(join(ws, "scripts"), { recursive: true });
  writeFileSync(join(rt, "secret-step-file"), "HOST-ONLY-DECOY");
  writeFileSync(join(ws, "scripts/d3-orchestrator.mjs"), PROBE.replace("process.env.PROBE_HOST_TEMP", JSON.stringify(join(rt, "secret-step-file"))));
  // the probe imports strayPids from the real module
  writeFileSync(join(ws, "scripts/agent-env.mjs"), readFileSync(join(dirname(fileURLToPath(import.meta.url)), "agent-env.mjs")));
  for (const p of [root, rt, ws, join(ws, "scripts")]) chmodSync(p, 0o755);
  // a long-lived host process holding a secret in its environment, like the runner's worker
  const holder = spawn("sleep", ["120"], { env: { ...process.env, RUNNER_SECRET: "HOST-ONLY-DECOY" }, stdio: "ignore" });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "id"), `#!/bin/bash\ncase "$1" in -u|-g) echo 1001;; *) echo "uid=1001";; esac\n`);
  chmodSync(join(bin, "id"), 0o755);
  try {
    execFileSync("bash", ["-e", "-c", stepScript(USER_STEP)], { env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: rt, AGENT_IMAGE: IMAGE }, stdio: "pipe" });
    const out = execFileSync("bash", ["-e", "-c", stepScript(AGENT_STEP)], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: ws, RUNNER_TEMP: rt,
        ...RUN_ENV, AGENT_IMAGE: IMAGE, SLACK_BOT_TOKEN: "HOST-ONLY-DECOY", GITHUB_TOKEN: "HOST-ONLY-DECOY", ACTIONS_RUNTIME_TOKEN: "HOST-ONLY-DECOY",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    const seen = JSON.parse(out.trim().split("\n").pop());
    assert.equal(seen.repoVisible, true);
    assert.equal(seen.uid, 1001);
    assert.equal(seen.key, "sk-d3-REAL"); // the one secret, by design
    // the allowlist, plus what docker and the image add on their own (HOSTNAME, PATH)
    assert.deepEqual(seen.envKeys, [
      "BRANCH", "BRIEF", "CI", KEY, "D3_FACTORY_SANDBOX", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
      "HOME", "HOSTNAME", "LANG", "PATH", "SLACK_USER", "TMPDIR",
    ].concat(seen.envKeys.includes("NODE_VERSION") ? ["NODE_VERSION"] : []).concat(seen.envKeys.includes("YARN_VERSION") ? ["YARN_VERSION"] : []).sort());
    assert.equal(seen.decoyInAnyProc, false, "a host secret was readable through /proc");
    assert.ok(!seen.comms.includes("sleep"), `host processes are visible: ${seen.comms}`);
    assert.ok(seen.procCount <= 5, `container sees ${seen.procCount} processes: ${seen.comms}`);
    assert.equal(seen.dockerSock, false);
    assert.equal(seen.rootWritable, false);
    assert.equal(seen.hostTempVisible, false);
    assert.equal(seen.capEff, "0000000000000000");
    assert.equal(seen.noNewPrivs, "1");
    assert.equal(seen.pid1, "docker-init"); // what the orchestrator requires before it sweeps processes
    assert.equal(seen.user, "d3agent"); // the runner uid has a passwd entry (os.userInfo() works)
    assert.equal(seen.strayBefore, true);
    assert.equal(seen.strayAfter, false, "a leftover process survived the sweep");
  } finally {
    holder.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

real("REAL commit container: git config an agent planted runs, but with no secret and no network, and the bundle is still produced", () => {
  const root = mkdtempSync(join(tmpdir(), "realc-"));
  const rt = join(root, "runner_temp");
  const ws = join(rt, "d3-agent-repo");
  mkdirSync(rt);
  const git = (...a) => execFileSync("git", a, { cwd: ws, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" });
  try {
    execFileSync("git", ["init", "-q", "-b", "develop", ws]);
    writeFileSync(join(ws, "f"), "base");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    git("checkout", "-qb", "factory/run-9");
    git("config", "user.name", "d3-factory");
    git("config", "user.email", "factory@phoresight.io");
    writeFileSync(join(ws, "feat.txt"), "feature");
    // what a hijacked coder could leave: an fsmonitor hook git runs on `git add`
    mkdirSync(join(ws, ".git/evil"));
    writeFileSync(join(ws, ".git/evil/fsmonitor"), `#!/bin/bash
{ env; (exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null && echo NETWORK=yes || echo NETWORK=no; } > /out/fsmonitor-ran 2>&1
exit 1
`);
    chmodSync(join(ws, ".git/evil/fsmonitor"), 0o755);
    git("config", "core.fsmonitor", "/work/repo/.git/evil/fsmonitor");
    const env = {
      PATH: process.env.PATH, GITHUB_WORKSPACE: ws, RUNNER_TEMP: rt, AGENT_IMAGE: IMAGE,
      RUN_ID: "9", BASE_SHA: base, BUNDLE_OUT: "/out",
      COMMIT_AND_BUNDLE: commitScript(),
      ...Object.fromEntries(Object.entries(DECOYS).map(([k]) => [k, "HOST-ONLY-DECOY"])), [KEY]: "HOST-ONLY-DECOY",
    };
    execFileSync("bash", ["-e", "-c", stepScript(USER_STEP)], { env, stdio: "pipe" });
    execFileSync("bash", ["-e", "-c", stepScript(COMMIT_STEP)], { env, encoding: "utf8", timeout: 120_000, stdio: "pipe" });
    // the planted hook ran inside the container...
    const ran = readFileSync(join(rt, "bundle-out/fsmonitor-ran"), "utf8");
    // ...with nothing worth stealing and nowhere to send it
    assert.doesNotMatch(ran, /HOST-ONLY-DECOY/);
    assert.match(ran, /NETWORK=no/);
    // and the bundle is a valid bundle of exactly the factory branch
    const bundle = join(rt, "factory.bundle");
    assert.ok(lstatSync(bundle).isFile());
    execFileSync("git", ["bundle", "verify", bundle], { cwd: ws, stdio: "pipe" });
    assert.match(execFileSync("git", ["bundle", "list-heads", bundle], { encoding: "utf8" }), /refs\/heads\/factory\/run-9$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// COMMIT_AND_BUNDLE from the workflow's env block.
function commitScript() {
  const lines = WORKFLOW.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${COMMIT_STEP}`);
  const r = lines.findIndex((l, k) => k > i && l.trim() === "COMMIT_AND_BUNDLE: |");
  const indent = lines[r].match(/^\s*/)[0].length;
  const body = [];
  for (let k = r + 1; k < lines.length && (lines[k].trim() === "" || lines[k].match(/^\s*/)[0].length > indent); k++) body.push(lines[k].slice(indent + 2));
  return body.join("\n").trim() + "\n";
}

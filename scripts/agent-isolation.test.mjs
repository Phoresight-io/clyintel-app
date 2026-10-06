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
import { join, dirname, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/d3-factory.yml"), "utf8");
const AGENT_STEP = "Run pipeline in the agent container (Planner → Coder → Tester → Reviewer)";
const COMMIT_STEP = "Commit and bundle the agents' work (container, no secrets, no network)";
const NOTES_STEP = "Collect the agents' notes (a regular file of at most 8 KB, or nothing)";
const CLEANUP_STEP = "Remove the agents' containers and working tree";
const COPY_STEP = "Copy the repo for the agents";
const USER_STEP = "Prepare the agent container's user entry";
const EGRESS_STEP = "Start the agents' internal network and egress proxy";
const KEY = "D3_FACTORY_ANTHROPIC_API_KEY";

// ---- workflow structure

const JOBS = ["prepare", "notify-start", "pipeline", "notify-agents", "publish", "notify-failure"];
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
  const holders = { "notify-start": ["SLACK_BOT_TOKEN"], "notify-agents": ["SLACK_BOT_TOKEN"], publish: ["SLACK_BOT_TOKEN", "RUN_LOG_SHEET_WEBHOOK"], "notify-failure": ["SLACK_BOT_TOKEN", "RUN_LOG_SHEET_WEBHOOK"] };
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
  assert.match(job("notify-agents"), /permissions: \{\}/);
});

test("workflow: the sandbox image is pinned by digest, and every step after the agents ran is containerised or cannot run agent code", () => {
  assert.match(job("pipeline"), /AGENT_IMAGE: node:22-bookworm@sha256:[0-9a-f]{64}\n/);
  const pipeline = codeOnly(job("pipeline"));
  const after = pipeline.slice(pipeline.indexOf(`- name: ${AGENT_STEP}`));
  // the steps after the agents: the agent container, the notes collection and upload (no agent code, no
  // git), the commit container, the bundle upload, the cleanup
  const names = [...after.matchAll(/- (?:name: (.+)|uses: (.+))/g)].map((m) => (m[1] ?? m[2]).trim());
  assert.deepEqual(names, [AGENT_STEP, NOTES_STEP, "actions/upload-artifact@v4", COMMIT_STEP, "actions/upload-artifact@v4", CLEANUP_STEP]);
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
    assert.ok(/d3-agent-repo|docker run --rm --network none|bundle-out|d3-etc|d3-proxy|d3-notes/.test(st), `step does not say where it works:\n${st.slice(0, 200)}`);
  }
});

// ---- the docker invocations, with a stub docker that records them

// Runs a step script with a stub `docker` (and a stub `id` that reports the hosted runner's uid 1001).
// The stub writes its argv and, for every `-e NAME` (no value), what the container would receive.
function withStubDocker(script, env, { bundle = "file", dnsExit = 3 } = {}) {
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
case "$1" in rm|network) exit 0;; logs) echo "egress proxy listening on 8888; allowed: api.anthropic.com:443"; exit 0;; esac
case "$*" in *d3-dnscheck-*) exit ${dnsExit};; esac
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
  // sudo only ever runs iptables here; record it, never touch the real firewall
  writeFileSync(join(bin, "sudo"), `#!/bin/bash\nprintf '%s\\0' "$@" >> "${root}/sudo.calls"; echo >> "${root}/sudo.calls"\n`);
  chmodSync(join(bin, "id"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "sudo"), 0o755);
  const r = spawnSync("bash", ["-e", "-c", script], {
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: ws, RUNNER_TEMP: rt, ...env },
    encoding: "utf8",
  });
  const argv = existsSync(join(root, "docker.argv")) ? readFileSync(join(root, "docker.argv"), "utf8").split("\0").slice(0, -1) : null;
  const cenv = existsSync(join(root, "docker.env"))
    ? Object.fromEntries(readFileSync(join(root, "docker.env"), "utf8").split("\0").slice(0, -1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]))
    : null;
  const calls = existsSync(join(root, "docker.calls")) ? readFileSync(join(root, "docker.calls"), "utf8").split("\0\n").filter(Boolean).map((l) => l.split("\0")) : [];
  const sudoCalls = existsSync(join(root, "sudo.calls")) ? readFileSync(join(root, "sudo.calls"), "utf8").split("\0\n").filter(Boolean).map((l) => l.split("\0")) : [];
  return { code: r.status, stderr: r.stderr, argv, cenv, calls, sudoCalls, ws, rt, root, done: () => rmSync(root, { recursive: true, force: true }) };
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
      "BRANCH", "BRIEF", "CI", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", KEY, "D3_FACTORY_SANDBOX", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
      "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "NO_PROXY", "SLACK_USER", "TMPDIR",
    ]);
    assert.equal(cenv[KEY], "sk-d3-REAL");
    // the only way out is the egress proxy
    assert.equal(cenv.HTTPS_PROXY, "http://proxy:8888");
    assert.equal(cenv.HTTP_PROXY, "http://proxy:8888");
    assert.equal(cenv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(cenv.D3_FACTORY_SANDBOX, "container");
    for (const v of Object.values(DECOYS)) assert.ok(!Object.values(cenv).includes(v), `decoy ${v} reached the container`);
    // the key is passed by NAME: its value is never on docker's command line (visible in ps)
    assert.ok(!argv.some((a) => a.includes("sk-d3-REAL")));
    assert.ok(flagValues(argv, "-e").includes(KEY));
    // mounts: the agents' copy (NOT the checkout) at /work/repo, and read-only passwd/group
    assert.deepEqual(flagValues(argv, "-v"), [`${r.rt}/d3-agent-repo:/work/repo`, `${r.rt}/d3-notes:/notes`, `${r.rt}/d3-etc/passwd:/etc/passwd:ro`, `${r.rt}/d3-etc/group:/etc/group:ro`]);
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
    assert.deepEqual(flagValues(argv, "--network"), ["d3-egress-9"]);
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
    assert.deepEqual(calls.find((c) => c[0] === "rm"), ["rm", "-f", "d3-agents-9", "d3-commit-9", "d3-proxy-9", "d3-dnscheck-9"]);
    assert.ok(calls.some((c) => c.join(" ") === "network rm d3-egress-9"), "the internal network is not removed");
    const sudo = readFileSync(join(r.root, "sudo.calls"), "utf8");
    assert.match(sudo, /iptables\0-D\0INPUT\0-i\0d3egress0\0-j\0DROP/, "the firewall rule is not removed");
    assert.match(job("pipeline"), new RegExp(`- name: ${CLEANUP_STEP}\\n\\s+if: always\\(\\)`));
  } finally { r.done(); }
});

// ---- egress: the agent container's only way out is the allowlist proxy

test("egress step: internal network, host firewall rule BEFORE the proxy starts, and a locked-down proxy from the trusted copy", () => {
  const r = withStubDocker(stepScript(EGRESS_STEP), { ...RUN_ENV });
  try {
    assert.equal(r.code, 0, r.stderr);
    const net = r.calls.findIndex((c) => c[0] === "network" && c[1] === "create");
    assert.ok(net >= 0, "no network created");
    assert.deepEqual(r.calls[net], ["network", "create", "--internal", "-o", "com.docker.network.bridge.name=d3egress0", "d3-egress-9"]);
    // the firewall rule drops what the internal network sends to the runner itself (its gateway)
    assert.deepEqual(r.sudoCalls[0], ["iptables", "-I", "INPUT", "-i", "d3egress0", "-j", "DROP"]);
    // the IPv6 rule is not optional where IPv6 exists: no `|| true` hiding a failure
    assert.match(stepScript(EGRESS_STEP), /if \[ -e \/proc\/net\/if_inet6 \]; then sudo ip6tables -I INPUT -i "\$EGRESS_IF" -j DROP; fi/);
    assert.doesNotMatch(stepScript(EGRESS_STEP), /ip6tables -I[^\n]*\|\| true/);
    // the proxy container: no secret, no privileges, read-only, the TRUSTED script read-only, pinned image
    const run = r.calls.find((c) => c[0] === "run");
    assert.ok(run, "proxy not started");
    assert.deepEqual(flagValues(run, "--name"), ["d3-proxy-9"]);
    assert.deepEqual(flagValues(run, "--user"), ["1001:1001"]);
    assert.deepEqual(flagValues(run, "--cap-drop"), ["ALL"]);
    assert.deepEqual(flagValues(run, "--security-opt"), ["no-new-privileges"]);
    assert.ok(run.includes("--read-only") && run.includes("--init"));
    assert.deepEqual(flagValues(run, "--network"), ["bridge"]);
    assert.deepEqual(flagValues(run, "-v"), [`${r.rt}/d3-proxy/egress-proxy.mjs:/proxy/egress-proxy.mjs:ro`]);
    assert.deepEqual(flagValues(run, "-e"), [], "the proxy gets no environment");
    assert.ok(!run.some((a) => a.includes("d3-agent-repo") || a.includes(r.ws)), "the proxy runs from the agents' copy or the checkout");
    assert.deepEqual(run.slice(-3), ["img@sha256:abc", "node", "/proxy/egress-proxy.mjs"]);
    for (const a of run) assert.doesNotMatch(a, /docker\.sock|^--privileged|^--cap-add|^--pid(=|$)|^--device|^--env-file|^--volumes-from/, a);
    // ...joined to the internal network as "proxy", which is what HTTPS_PROXY names
    assert.ok(r.calls.some((c) => c.join(" ") === "network connect --alias proxy d3-egress-9 d3-proxy-9"));
    // ordering: network, then firewall, then proxy (the sudo stub has no clock, so check the step text)
    const script = stepScript(EGRESS_STEP);
    assert.ok(script.indexOf("network create") < script.indexOf("iptables -I") && script.indexOf("iptables -I") < script.indexOf("docker run"), "firewall rule must be in place before anything runs on the network");
  } finally { r.done(); }
});

test("egress step: fails closed if the internal network resolves outside names (DNS would be a way out)", () => {
  const ok = withStubDocker(stepScript(EGRESS_STEP), { ...RUN_ENV });
  try {
    assert.equal(ok.code, 0, ok.stderr);
    const check = ok.calls.find((c) => c[0] === "run" && c.includes("d3-dnscheck-9"));
    assert.ok(check, "no DNS check");
    assert.deepEqual(flagValues(check, "--network"), ["d3-egress-9"]);
    // docker's own flags are the ones before the image (`node -e` after it is the probe's script)
    assert.deepEqual(flagValues(check.slice(0, check.indexOf("img@sha256:abc")), "-e"), [], "the DNS check gets no environment");
    assert.ok(check.includes("--read-only") && flagValues(check, "--cap-drop")[0] === "ALL");
  } finally { ok.done(); }
  const leak = withStubDocker(stepScript(EGRESS_STEP), { ...RUN_ENV }, { dnsExit: 0 });
  try {
    assert.notEqual(leak.code, 0, "the step went on although outside DNS resolves");
    assert.match(leak.stderr, /Outside DNS resolves/);
  } finally { leak.done(); }
  // only positive proof (exit 3) lets the run go on: a probe that never ran, crashed, or failed for
  // another reason is not a check
  for (const rc of [1, 4, 125, 126, 127, 137]) {
    const r = withStubDocker(stepScript(EGRESS_STEP), { ...RUN_ENV }, { dnsExit: rc });
    try {
      assert.notEqual(r.code, 0, `the step went on after a DNS check that exited ${rc}`);
      assert.match(r.stderr, new RegExp(`did not run cleanly \\(exit ${rc}\\)`));
    } finally { r.done(); }
  }
});

test("egress: the proxy script is copied from the checkout in the Copy step, before any agent runs, outside the agents' copy", () => {
  const copy = stepScript(COPY_STEP);
  assert.match(copy, /cp -- "\$GITHUB_WORKSPACE\/scripts\/egress-proxy\.mjs" "\$PROXY_DIR\/egress-proxy\.mjs"/);
  assert.match(copy, /PROXY_DIR="\$RUNNER_TEMP\/d3-proxy"/);
  assert.match(copy, /chmod 0444 "\$PROXY_DIR\/egress-proxy\.mjs"/);
  const pipeline = codeOnly(job("pipeline"));
  const at = (name) => pipeline.indexOf(`- name: ${name}`);
  assert.ok(at(COPY_STEP) < at(EGRESS_STEP) && at(EGRESS_STEP) < at(AGENT_STEP), "proxy must be up before the agents start");
  // the agents never get the proxy's directory
  assert.doesNotMatch(stepScript(AGENT_STEP), /d3-proxy/);
  // the egress step itself holds no secret
  const egressBlock = pipeline.slice(at(EGRESS_STEP), at(AGENT_STEP));
  assert.doesNotMatch(egressBlock, /secrets\./);
  // scripts/ (and so the proxy) is protected from factory runs
  const protectedLine = WORKFLOW.split("\n").find((l) => l.trim().startsWith("PROTECTED="));
  const re = new RegExp(protectedLine.trim().replace(/^PROTECTED='/, "").replace(/'$/, ""), "i");
  assert.ok(re.test("scripts/egress-proxy.mjs"), "publish must refuse a factory change to the proxy");
});

test("egress: the agents' environment forwards the proxy and the no-telemetry switch, and nothing new that is secret", async () => {
  const { agentEnv } = await import("./agent-env.mjs");
  const env = agentEnv({ [KEY]: "sk-x", PATH: "/bin", HTTPS_PROXY: "http://proxy:8888", HTTP_PROXY: "http://proxy:8888", NO_PROXY: "localhost", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", SLACK_BOT_TOKEN: "xoxb" });
  assert.equal(env.HTTPS_PROXY, "http://proxy:8888");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
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

// Brings up the egress step for real (network, firewall rule, proxy) in `rt`, and tears it down.
// Needs passwordless sudo for iptables, as on a GitHub-hosted runner.
function realEgressUp(rt, bin) {
  mkdirSync(join(rt, "d3-proxy"), { recursive: true });
  writeFileSync(join(rt, "d3-proxy/egress-proxy.mjs"), readFileSync(join(dirname(fileURLToPath(import.meta.url)), "egress-proxy.mjs")));
  chmodSync(join(rt, "d3-proxy"), 0o755);
  chmodSync(join(rt, "d3-proxy/egress-proxy.mjs"), 0o444);
  realEgressDown(); // a leftover from an aborted earlier run would make `network create` fail
  execFileSync("bash", ["-e", "-c", stepScript(EGRESS_STEP)], {
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: rt, GITHUB_RUN_ID: "9", AGENT_IMAGE: IMAGE }, stdio: "pipe", timeout: 60_000,
  });
}
function realEgressDown() {
  spawnSync("docker", ["rm", "-f", "d3-proxy-9", "d3-agents-9", "d3-dnscheck-9"], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", "d3-egress-9"], { stdio: "ignore" });
  spawnSync("sudo", ["-n", "iptables", "-D", "INPUT", "-i", "d3egress0", "-j", "DROP"], { stdio: "ignore" });
}

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
    realEgressUp(rt, bin);
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
      "BRANCH", "BRIEF", "CI", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", KEY, "D3_FACTORY_SANDBOX", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
      "HOME", "HOSTNAME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "NO_PROXY", "PATH", "SLACK_USER", "TMPDIR",
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
    realEgressDown();
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

// Rules (other than "factory/**" itself) set to true that could match a factory branch. Two checks,
// either is enough to flag a rule, so the guard errs towards refusing:
//   - a real glob match against sample branch names (node's path.matchesGlob, minimatch-style);
//   - a loose one, in case Vercel's matcher lets * cross "/": the pattern's literal prefix (up to
//     its first glob character) is a prefix of "factory/run-", or is itself under factory.
const FACTORY_BRANCHES = ["factory/run-1", "factory/run-18157293401"];
function factoryReEnablingRules(deploymentEnabled) {
  return Object.entries(deploymentEnabled)
    .filter(([pattern, on]) => pattern !== "factory/**" && on !== false)
    .filter(([pattern]) => {
      if (FACTORY_BRANCHES.some((b) => matchesGlob(b, pattern))) return true;
      const literal = pattern.match(/^[^*?[{\\]*/)[0];
      return "factory/run-".startsWith(literal) || literal.toLowerCase().startsWith("factory");
    })
    .map(([pattern]) => pattern);
}

// Vercel would otherwise build a preview of every factory/run-* branch: unreviewed agent code, run
// with the Preview environment's variables. clyintel/vercel.json turns those deployments off, and
// publish refuses any run that edits vercel.json, so an agent cannot turn them back on.
test("vercel.json: Git deployments are off for factory branches, and publish protects vercel.json", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Both Vercel projects build from clyintel/ (their Root Directory). The repo-root vercel.json is
  // not used today but carries the same rule, so a project pointed at the repo root is covered too.
  // slack-dispatch/ is the /d3 handler's own project; its vercel.json carries the rule as well.
  for (const rel of ["clyintel/vercel.json", "vercel.json", "slack-dispatch/vercel.json"]) {
    const vercel = JSON.parse(readFileSync(join(root, rel), "utf8"));
    assert.equal(vercel.git?.deploymentEnabled?.["factory/**"], false, rel);
    // no other rule may re-enable a factory branch (Vercel deploys if ANY matching rule is true)
    assert.deepEqual(factoryReEnablingRules(vercel.git.deploymentEnabled), [], rel);
  }
  // the guard itself catches rules a prefix check missed
  for (const evil of ["*/**", "f*", "fac*/*", "{factory,x}/**", "?actory/**", "**", "*", "factory/run-*", "factory/run-1", "factory*"])
    assert.deepEqual(factoryReEnablingRules({ "factory/**": false, [evil]: true }), [evil], evil);
  // and leaves ordinary rules alone
  assert.deepEqual(factoryReEnablingRules({ "factory/**": false, main: true, develop: true, "release/*": true, "feature/**": true, "*/**": false }), []);
  // the branch the workflow pushes is under factory/
  assert.match(WORKFLOW, /BRANCH: factory\/run-\$\{\{ github\.run_id \}\}/);
  // publish's PROTECTED list covers vercel.json
  const protectedLine = WORKFLOW.split("\n").find((l) => l.trim().startsWith("PROTECTED="));
  const re = new RegExp(protectedLine.trim().replace(/^PROTECTED='/, "").replace(/'$/, ""), "i");
  for (const rel of ["clyintel/vercel.json", "vercel.json", "slack-dispatch/vercel.json"]) assert.ok(re.test(rel), `publish must refuse a change to ${rel}`);
});

// What the agents can reach on the network, reported from inside the real agent container by a
// stand-in "orchestrator". Direct connections, the runner itself (on the internal network's own
// gateway, and on the default bridge's), the cloud metadata addresses, outside DNS, and the proxy.
const EGRESS_PROBE = `
import net from "node:net";
import os from "node:os";
import dns from "node:dns/promises";
const tcp = (host, port) => new Promise((res) => {
  const s = net.connect({ host, port, timeout: 3000 });
  s.on("connect", () => { s.destroy(); res("OPEN"); });
  s.on("timeout", () => { s.destroy(); res("timeout"); });
  s.on("error", (e) => res(e.code));
});
const viaProxy = (request) => new Promise((res) => {
  const s = net.connect({ host: "proxy", port: 8888, timeout: 20000 });
  let buf = "";
  s.on("connect", () => s.write(request));
  s.on("data", (d) => { buf += d; if (buf.includes("\\r\\n")) { s.destroy(); res(buf.split("\\r\\n")[0]); } });
  s.on("timeout", () => { s.destroy(); res("timeout"); });
  s.on("error", (e) => res(e.code));
  s.on("close", () => res(buf.split("\\r\\n")[0] || "closed"));
});
const addr = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal).address;
const ownGateway = addr.split(".").slice(0, 3).concat("1").join(".");
const HOST_PORT = Number(process.env.PROBE_HOST_PORT || "0");
const out = { ownGateway, direct: {}, proxy: {} };
for (const [h, p] of [["1.1.1.1", 443], ["api.anthropic.com", 443], ["169.254.169.254", 80], ["168.63.129.16", 80], ["172.17.0.1", HOST_PORT], [ownGateway, HOST_PORT], [ownGateway, 22]]) {
  out.direct[h + ":" + p] = await tcp(h, p);
}
try { out.dns = (await dns.lookup("example.com")).address; } catch (e) { out.dns = e.code; }
out.proxy.anthropic = await viaProxy("CONNECT api.anthropic.com:443 HTTP/1.1\\r\\nHost: api.anthropic.com:443\\r\\n\\r\\n");
out.proxy.example = await viaProxy("CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n");
out.proxy.metadata = await viaProxy("CONNECT 169.254.169.254:80 HTTP/1.1\\r\\n\\r\\n");
out.proxy.plainHttp = await viaProxy("GET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n");
console.log(JSON.stringify(out));
`;

real("REAL egress: the agent container reaches only api.anthropic.com:443 through the proxy; not the runner, metadata, DNS or anything else", async () => {
  const root = mkdtempSync(join(tmpdir(), "reale-"));
  const rt = join(root, "runner_temp");
  const ws = join(rt, "d3-agent-repo");
  mkdirSync(join(ws, "scripts"), { recursive: true });
  writeFileSync(join(ws, "scripts/d3-orchestrator.mjs"), EGRESS_PROBE);
  for (const p of [root, rt, ws, join(ws, "scripts")]) chmodSync(p, 0o755);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "id"), `#!/bin/bash\ncase "$1" in -u|-g) echo 1001;; *) echo "uid=1001";; esac\n`);
  chmodSync(join(bin, "id"), 0o755);
  // a service on the runner, listening on every address: what the firewall rule must hide
  const net = await import("node:net");
  const hostService = net.createServer((s) => s.end("runner-secret\n"));
  await new Promise((r) => hostService.listen(0, "0.0.0.0", r));
  try {
    execFileSync("bash", ["-e", "-c", stepScript(USER_STEP)], { env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: rt, AGENT_IMAGE: IMAGE }, stdio: "pipe" });
    realEgressUp(rt, bin);
    const out = execFileSync("bash", ["-e", "-c", stepScript(AGENT_STEP).replace("-e GITHUB_RUN_ID", "-e GITHUB_RUN_ID -e PROBE_HOST_PORT")], {
      env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: rt, ...RUN_ENV, AGENT_IMAGE: IMAGE, PROBE_HOST_PORT: String(hostService.address().port) },
      encoding: "utf8",
      timeout: 180_000,
    });
    const seen = JSON.parse(out.trim().split("\n").pop());
    // nothing is reachable directly: not the internet, not the API itself, not the metadata
    // services, and not the runner (on either bridge's gateway), even with a service listening
    for (const [target, result] of Object.entries(seen.direct)) assert.notEqual(result, "OPEN", `${target} is reachable directly`);
    assert.notEqual(seen.dns, undefined);
    assert.ok(!/^\d+\.\d+\.\d+\.\d+$/.test(String(seen.dns)), `outside DNS resolves: ${seen.dns}`);
    // through the proxy: everything but the API is refused
    assert.match(seen.proxy.example, /^HTTP\/1\.1 403/);
    assert.match(seen.proxy.metadata, /^HTTP\/1\.1 403/);
    assert.match(seen.proxy.plainHttp, /^HTTP\/1\.1 403/);
    // and the API is allowed: 200 when this machine can reach it, 502 when it is offline (a sandbox
    // without internet). D3_EGRESS_TEST_ONLINE=1 requires the 200.
    if (process.env.D3_EGRESS_TEST_ONLINE === "1") assert.match(seen.proxy.anthropic, /^HTTP\/1\.1 200/);
    else assert.match(seen.proxy.anthropic, /^HTTP\/1\.1 (200|502)/);
    // the proxy logged its decisions, which the cleanup step prints
    const log = execFileSync("docker", ["logs", "d3-proxy-9"], { encoding: "utf8" });
    assert.match(log, /^allow CONNECT api\.anthropic\.com:443$/m);
    assert.match(log, /^deny CONNECT example\.com:443$/m);
  } finally {
    hostService.close();
    realEgressDown();
    rmSync(root, { recursive: true, force: true });
  }
});

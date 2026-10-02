// Run with: node --test scripts/agent-env.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY_KEY, factoryKey, agentEnv, unexpectedCredentials, inSandbox, MissingKeyError, strayPids, isContainerInit } from "./agent-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("factoryKey: the dedicated key is mandatory; ANTHROPIC_API_KEY is never a fallback", () => {
  assert.equal(FACTORY_KEY, "D3_FACTORY_ANTHROPIC_API_KEY");
  assert.equal(factoryKey({ D3_FACTORY_ANTHROPIC_API_KEY: "sk-d3" }), "sk-d3");
  assert.equal(factoryKey({ D3_FACTORY_ANTHROPIC_API_KEY: "  sk-d3\n" }), "sk-d3");
  for (const env of [{}, { D3_FACTORY_ANTHROPIC_API_KEY: "" }, { D3_FACTORY_ANTHROPIC_API_KEY: "  \n" }, { ANTHROPIC_API_KEY: "sk-shared" }]) {
    assert.throws(() => factoryKey(env), MissingKeyError, JSON.stringify(Object.keys(env)));
  }
  // the error says what to do, and never echoes a value
  assert.throws(() => factoryKey({ ANTHROPIC_API_KEY: "sk-shared" }), (e) => /no fallback to ANTHROPIC_API_KEY/.test(e.message) && !e.message.includes("sk-shared"));
});

test("agentEnv: sessions get the dedicated key as ANTHROPIC_API_KEY plus harmless variables, nothing else", () => {
  const env = agentEnv({
    D3_FACTORY_ANTHROPIC_API_KEY: "sk-d3",
    ANTHROPIC_API_KEY: "sk-shared", // must be ignored, not forwarded
    PATH: "/usr/bin", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: "/tmp", CI: "true",
    SLACK_BOT_TOKEN: "xoxb", RUN_LOG_SHEET_WEBHOOK: "https://hook", GITHUB_TOKEN: "ghs", ACTIONS_RUNTIME_TOKEN: "rt",
    BRIEF: "b", D3_FACTORY_SANDBOX: "container",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/tmp", LANG: "C.UTF-8", TMPDIR: "/tmp", CI: "true", ANTHROPIC_API_KEY: "sk-d3" });
  assert.throws(() => agentEnv({ ANTHROPIC_API_KEY: "sk-shared", PATH: "/usr/bin" }), MissingKeyError);
});

test("unexpectedCredentials / inSandbox: tripwires for the isolation being undone", () => {
  assert.deepEqual(unexpectedCredentials({ D3_FACTORY_ANTHROPIC_API_KEY: "k", BRIEF: "b", BRANCH: "x", GITHUB_RUN_ID: "1", GITHUB_REPOSITORY: "a/b", GITHUB_ACTOR: "c", SLACK_USER: "U1", HOME: "/tmp", PATH: "/bin", CI: "true" }), []);
  assert.deepEqual(
    unexpectedCredentials({
      D3_FACTORY_ANTHROPIC_API_KEY: "k", ANTHROPIC_API_KEY: "s", SLACK_BOT_TOKEN: "x", RUN_LOG_SHEET_WEBHOOK: "w",
      GITHUB_TOKEN: "g", ACTIONS_RUNTIME_TOKEN: "r", ACTIONS_ID_TOKEN_REQUEST_URL: "u", RUNNER_TEMP: "/t", STRIPE_SECRET_KEY: "sk",
    }),
    ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "RUNNER_TEMP", "RUN_LOG_SHEET_WEBHOOK", "SLACK_BOT_TOKEN", "STRIPE_SECRET_KEY"]
  );
  assert.equal(inSandbox({ D3_FACTORY_SANDBOX: "container" }), true);
  for (const v of [undefined, "", "1", "true", "Container"]) assert.equal(inSandbox({ D3_FACTORY_SANDBOX: v }), false, String(v));
});

// The orchestrator's start-up refusals, run for real. Every case here exits before the brief is
// even read (and BRIEF is unset anyway, which is its own refusal), so no agent session can start.
function orchestrate(env) {
  const r = spawnSync(process.execPath, [join(HERE, "d3-orchestrator.mjs")], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, err: r.stderr };
}

test("strayPids / isContainerInit: everything but init and the orchestrator is a leftover; only a container init counts", () => {
  assert.deepEqual(strayPids(["1", "7", "self", "42", "thread-self", "100", "sys"], new Set([1, 7])), [42, 100]);
  assert.deepEqual(strayPids(["1", "7"], new Set([1, 7])), []);
  assert.equal(isContainerInit("docker-init\n"), true);
  assert.equal(isContainerInit("tini"), true);
  for (const c of ["systemd", "init", "bash", "", undefined]) assert.equal(isContainerInit(c), false, String(c));
});

test("orchestrator: refuses to start outside the agent container, even with the marker set", () => {
  for (const env of [{ D3_FACTORY_ANTHROPIC_API_KEY: "sk-d3-test" }, { D3_FACTORY_ANTHROPIC_API_KEY: "sk-d3-test", D3_FACTORY_SANDBOX: "container" }]) {
    const r = orchestrate(env);
    assert.equal(r.code, 1);
    assert.match(r.err, /outside the agent container/);
    assert.doesNotMatch(r.err, /sk-d3-test/);
  }
});

test("orchestrator: refuses when any other credential reached the container, naming it but never printing values", () => {
  const r = orchestrate({ D3_FACTORY_SANDBOX: "container", D3_FACTORY_ANTHROPIC_API_KEY: "sk-d3-test", SLACK_BOT_TOKEN: "xoxb-VALUE", RUN_LOG_SHEET_WEBHOOK: "https://hook.example/VALUE" });
  assert.equal(r.code, 1);
  assert.match(r.err, /RUN_LOG_SHEET_WEBHOOK, SLACK_BOT_TOKEN/);
  assert.match(r.err, /exactly one secret/);
  assert.doesNotMatch(r.err, /VALUE|sk-d3-test/);
});

test("orchestrator: refuses without D3_FACTORY_ANTHROPIC_API_KEY, and the shared ANTHROPIC_API_KEY does not stand in for it", () => {
  const missing = orchestrate({ D3_FACTORY_SANDBOX: "container" });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /D3_FACTORY_ANTHROPIC_API_KEY is not set/);
  const shared = orchestrate({ D3_FACTORY_SANDBOX: "container", ANTHROPIC_API_KEY: "sk-shared-VALUE" });
  assert.equal(shared.code, 1);
  assert.match(shared.err, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(shared.err, /sk-shared-VALUE/);
});

test("orchestrator source: no Slack, no Sheet webhook, sessions get agentEnv() and run in the repo root", () => {
  const src = readFileSync(join(HERE, "d3-orchestrator.mjs"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, ""); // comments may mention them; code may not
  assert.doesNotMatch(code, /slack|SLACK_|RUN_LOG_SHEET_WEBHOOK|pushRunLogToSheet|fetch\(/i);
  assert.match(code, /env: sessionEnv,/);
  assert.match(code, /cwd: repoRoot,/);
  assert.match(code, /escapingSymlinks\(repoRoot\)/);
  // the run-log module no longer has a network path either
  const runLog = readFileSync(join(HERE, "run-log.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(runLog, /fetch\(|WEBHOOK/);
});

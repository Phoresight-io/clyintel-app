// The environment the agent sessions get, and the one key they are allowed to spend.
//
// The factory runs on D3_FACTORY_ANTHROPIC_API_KEY and nothing else: a dedicated, spend-capped key
// that can be rotated apart from PR review. There is deliberately NO fallback to ANTHROPIC_API_KEY
// (the shared key PR review uses): if the dedicated key is missing the run stops before any agent
// starts, instead of quietly spending an uncapped key that a hijacked agent could then read.
//
// The sessions see that key under the name the CLI expects (ANTHROPIC_API_KEY), plus a short
// allowlist of harmless variables. This is least privilege inside the agent container, not the
// boundary itself: the coder's Bash can read the session's own environment, so the key is
// assumed reachable by an injected agent, which is why it is the ONLY secret the agent job holds.

export const FACTORY_KEY = "D3_FACTORY_ANTHROPIC_API_KEY";

// Never secrets. HOME/TMPDIR point into the container's tmpfs.
const PASSTHROUGH = ["PATH", "HOME", "LANG", "TMPDIR", "CI", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];

export class MissingKeyError extends Error {}

// The dedicated key, or a MissingKeyError. Whitespace-only counts as missing (an empty secret in
// GitHub expands to "").
export function factoryKey(env = process.env) {
  const key = env[FACTORY_KEY];
  if (typeof key !== "string" || key.trim() === "") {
    throw new MissingKeyError(
      `${FACTORY_KEY} is not set. The factory only runs on its dedicated, spend-capped key ` +
        `(there is no fallback to ANTHROPIC_API_KEY); add it under Settings -> Secrets and variables -> Actions.`
    );
  }
  return key.trim();
}

// The env passed to every query(): the passthrough variables that are set, and the dedicated key as
// ANTHROPIC_API_KEY. Any ANTHROPIC_API_KEY already in `env` is ignored, never forwarded.
export function agentEnv(env = process.env) {
  const out = {};
  for (const k of PASSTHROUGH) if (env[k] !== undefined) out[k] = env[k];
  out.ANTHROPIC_API_KEY = factoryKey(env);
  return out;
}

// Tripwire for the orchestrator's own environment, checked before any agent starts. The workflow
// starts it in the agent container with an explicit list of variables, so finding a credential-like
// name here (a Slack token, the Sheet webhook, GITHUB_TOKEN, the runner's ACTIONS_* tokens, or the
// shared ANTHROPIC_API_KEY) means the isolation was undone, e.g. the step was moved back onto the
// runner. Names only; values are never looked at or printed.
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|CREDENTIAL|PRIVATE|_KEY|^KEY)/i;
export function unexpectedCredentials(env = process.env) {
  return Object.keys(env)
    .filter((k) => k !== FACTORY_KEY && (CREDENTIAL_NAME.test(k) || /^(ACTIONS_|RUNNER_|GITHUB_TOKEN$)/.test(k)))
    .sort();
}

// The workflow sets D3_FACTORY_SANDBOX=container on the agent container. Without it the orchestrator
// is running somewhere it can see the runner, so it refuses. Like any env check this is a tripwire
// against the workflow regressing, not a boundary.
export const SANDBOX_MARKER = "D3_FACTORY_SANDBOX";
export const inSandbox = (env = process.env) => env[SANDBOX_MARKER] === "container";

// Processes left behind by an earlier session (a coder can start a background loop with setsid
// that outlives its Bash call and, say, swaps files under the reviewer between the role guard's
// check and the actual Read). Inside the agent container the only processes that should exist between
// sessions are init (pid 1) and the orchestrator itself; everything else is a leftover.
// `entries` is a /proc listing; returns the numeric pids not in `keep`.
export function strayPids(entries, keep) {
  return entries.filter((e) => /^\d+$/.test(e)).map(Number).filter((pid) => !keep.has(pid)).sort((a, b) => a - b);
}

// The workflow starts the agent container with --init, so pid 1 is docker's init. Checked before the
// orchestrator kills leftover processes: on a host, "every process but me and pid 1" is everything
// the user owns, so the orchestrator refuses to run at all unless pid 1 is that init.
export const isContainerInit = (comm) => ["docker-init", "tini"].includes(String(comm ?? "").trim());

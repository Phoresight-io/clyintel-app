// One-line, timestamped log lines for the orchestrator (subagent start/finish, role-guard
// decisions, per-run usage). Pure stdlib, no dependencies.
//
// Everything here ends up in the public-to-the-repo workflow log, and part of it (file paths,
// shell commands, denial reasons) is written by the agents. So every line starts with a fixed
// "[factory]" prefix (a line can never start with "::" and be read as a workflow command), has
// control characters and newlines removed, and is length-capped.

const MAX = 240;

export const clean = (value, max = MAX) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export const logLine = (message, now = new Date()) => `[factory] ${now.toISOString()} ${clean(message)}`;

// What a tool call is about, for the trace: the file for Write/Edit, the (truncated) command
// for Bash. Reads/greps are not traced.
export function describeCall(input) {
  const tool = input?.tool_name;
  const args = input?.tool_input ?? {};
  if (tool === "Write" || tool === "Edit") return `${tool} ${clean(args.file_path, 160)}`;
  if (tool === "Bash") return `Bash ${clean(args.command, 160)}`;
  return null;
}

export const who = (input) => (input?.agent_id ? input.agent_type || "unknown-subagent" : "main");

// Seconds, one decimal, for "finished in" figures.
export const seconds = (ms) => (Math.round(ms / 100) / 10).toFixed(1);

export const money = (usd) => `$${(Number(usd) || 0).toFixed(4)}`;

// The orchestrator's tracing, kept here so it can be tested without starting a pipeline.
// `log` receives plain messages (the caller adds the prefix/timestamp), `usage` is the shared
// { turns, cost, denials } accumulator. Nothing here can change an agent's permissions.
export function createTracer(log, usage, now = () => Date.now()) {
  const stats = new Map(); // agent_id -> { type, started, calls, denied }
  const finished = new Set(); // the stop hook can fire more than once per subagent; log the first only
  const statsFor = (input) => {
    if (!input?.agent_id) return null;
    if (!stats.has(input.agent_id)) stats.set(input.agent_id, { type: who(input), started: now(), calls: 0, denied: 0 });
    return stats.get(input.agent_id);
  };
  return {
    stats,
    onGuardDecision(input, out) {
      const st = statsFor(input);
      if (st) st.calls += 1;
      const call = describeCall(input);
      const d = out?.hookSpecificOutput;
      if (d?.permissionDecision === "deny") {
        usage.denials += 1;
        if (st) st.denied += 1;
        log(`role-guard DENIED ${who(input)} ${call ?? input?.tool_name}: ${d.permissionDecisionReason ?? ""}`.slice(0, 400));
      } else if (call && st) {
        log(`${who(input)} ${call}`); // trace of writes and shell commands only, not reads
      }
    },
    onSubagentStart(input) {
      statsFor(input);
      log(`subagent START ${who(input)} (${input?.agent_id})`);
    },
    onSubagentStop(input) {
      if (finished.has(input?.agent_id)) return;
      finished.add(input?.agent_id);
      const st = stats.get(input?.agent_id);
      const took = st ? ` in ${seconds(now() - st.started)}s, ${st.calls} tool calls, ${st.denied} denied` : "";
      log(`subagent FINISH ${who(input)} (${input?.agent_id})${took}`);
    },
  };
}

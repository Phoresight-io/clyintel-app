import test from "node:test";
import assert from "node:assert/strict";
import { clean, logLine, describeCall, who, money, seconds, createTracer } from "./factory-log.mjs";

test("every line starts with the fixed prefix and a timestamp, whatever the agent wrote", () => {
  const l = logLine("::add-mask::secret\n::stop-commands::x\r\tfoo", new Date("2026-10-02T13:06:15Z"));
  assert.equal(l, "[factory] 2026-10-02T13:06:15.000Z ::add-mask::secret ::stop-commands::x foo");
  assert.ok(!l.includes("\n") && !l.startsWith("::"));
  assert.ok(logLine("x".repeat(1000)).length < 300);
  assert.equal(clean(undefined), "");
  assert.equal(clean("a\u0000b\u202ec"), "a b c");
});

test("describeCall names the file or command for Write/Edit/Bash only", () => {
  assert.equal(describeCall({ tool_name: "Edit", tool_input: { file_path: "schema/README.md" } }), "Edit schema/README.md");
  assert.equal(describeCall({ tool_name: "Write", tool_input: { file_path: "a\nb" } }), "Write a b");
  assert.equal(describeCall({ tool_name: "Bash", tool_input: { command: "sed -i 1d x\nls" } }), "Bash sed -i 1d x ls");
  assert.equal(describeCall({ tool_name: "Read", tool_input: { file_path: "x" } }), null);
  assert.equal(describeCall({ tool_name: "Bash", tool_input: { command: "x".repeat(500) } }).length, 5 + 160);
  assert.equal(describeCall(undefined), null);
});

test("who / money / seconds", () => {
  assert.equal(who({ agent_id: "a", agent_type: "coder" }), "coder");
  assert.equal(who({}), "main");
  assert.equal(who({ agent_id: "a" }), "unknown-subagent");
  assert.equal(money(0.123456), "$0.1235");
  assert.equal(money(undefined), "$0.0000");
  assert.equal(seconds(4170), "4.2");
});

test("tracer: start/finish lines, denial lines with the reason, write/shell trace, counts", () => {
  const lines = [];
  const usage = { turns: 0, cost: 0, denials: 0 };
  let t = 1000;
  const tr = createTracer((m) => lines.push(m), usage, () => t);
  const coder = { agent_id: "a1", agent_type: "coder" };
  tr.onSubagentStart(coder);
  t = 4200;
  tr.onGuardDecision({ ...coder, tool_name: "Read", tool_input: { file_path: "x" } }, {}); // reads are counted, not traced
  tr.onGuardDecision({ ...coder, tool_name: "Bash", tool_input: { command: "sed -i 1d schema/README.md" } }, {});
  tr.onGuardDecision(
    { ...coder, tool_name: "Edit", tool_input: { file_path: "schema/README.md" } },
    { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "coder may not Edit schema/" } },
  );
  tr.onGuardDecision({ tool_name: "Bash", tool_input: { command: "ls" } }, { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "main thread" } });
  t = 11200;
  tr.onSubagentStop(coder);
  tr.onSubagentStop({ agent_id: "never-started", agent_type: "tester" });
  assert.deepEqual(lines, [
    "subagent START coder (a1)",
    "coder Bash sed -i 1d schema/README.md",
    "role-guard DENIED coder Edit schema/README.md: coder may not Edit schema/",
    "role-guard DENIED main Bash ls: main thread",
    "subagent FINISH coder (a1) in 10.2s, 3 tool calls, 1 denied",
    "subagent FINISH tester (never-started)",
  ]);
  assert.equal(usage.denials, 2);
});

test("tracer: a subagent's FINISH line is logged once even if the stop hook fires repeatedly", () => {
  const lines = [];
  const tr = createTracer((m) => lines.push(m), { turns: 0, cost: 0, denials: 0 }, () => 0);
  const planner = { agent_id: "p1", agent_type: "planner" };
  tr.onSubagentStart(planner);
  for (let i = 0; i < 4; i++) tr.onSubagentStop(planner);
  tr.onSubagentStart({ agent_id: "p2", agent_type: "planner" }); // a later, different subagent still logs
  tr.onSubagentStop({ agent_id: "p2", agent_type: "planner" });
  assert.deepEqual(lines.filter((l) => l.includes("FINISH")), [
    "subagent FINISH planner (p1) in 0.0s, 0 tool calls, 0 denied",
    "subagent FINISH planner (p2) in 0.0s, 0 tool calls, 0 denied",
  ]);
});

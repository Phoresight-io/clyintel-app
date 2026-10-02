import test from "node:test";
import assert from "node:assert/strict";
import { fixStep, PLAN_ERROR_PROMPT, TEST_FAILURE_PROMPT } from "./fix-loop.mjs";

const report = (reason) => `# Test report: x\n## Result: FAIL\n${reason ? `## Failure reason: ${reason}\n` : ""}## Coverage of acceptance criteria\n`;

test("a plan-error FAIL goes to the planner first, then the coder, then the tester", () => {
  const step = fixStep(report("plan error"));
  assert.equal(step.kind, "plan-error");
  assert.equal(step.prompt, PLAN_ERROR_PROMPT);
  const p = step.prompt;
  const at = (s) => p.indexOf(s);
  assert.ok(at("planner agent") > -1 && at("coder agent") > at("planner agent") && at("tester agent") > at("coder agent"), "order planner → coder → tester");
  assert.match(p, /VERIFY each claimed error/);
  assert.match(p, /exactly as written in the corrected plan/);
  assert.match(step.slack, /error in the plan/);
});

test("every other FAIL (test failure, could not run, no reason, no report) goes to the coder as before", () => {
  for (const text of [report("test failure"), report("could not run the suite"), report(""), report("the plan was wrong"), "", "garbage"]) {
    const step = fixStep(text);
    assert.equal(step.kind, "fix", JSON.stringify(text));
    assert.equal(step.prompt, TEST_FAILURE_PROMPT);
    assert.doesNotMatch(step.prompt, /planner/);
  }
});

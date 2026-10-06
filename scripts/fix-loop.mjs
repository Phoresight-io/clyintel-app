// The orchestrator's single fix attempt after a failed test gate, as pure functions so the routing
// can be tested without starting a pipeline. The tester says WHY it failed in an explicit
// "## Failure reason:" line (parseFailureReason); only the exact words "plan error" change the route.
import { parseFailureReason } from "./run-log.mjs";

export const PLAN_ERROR_PROMPT = `The tester reported FAIL with reason "plan error": an acceptance criterion or a
fact in .factory/plan.md is wrong (the code may be fine). Do these in order:

1. Use the planner agent to correct .factory/plan.md. It must first read .factory/test-report.md,
   then VERIFY each claimed error against the repository itself (do not just take the tester's word),
   and correct only what is actually wrong, keeping the goal and scope. It records every change under a
   "## Plan corrections" heading (what was wrong, what it is now). If the plan turns out to be right, it
   leaves the plan unchanged and says so, and the failure is then a problem in the code or the tests.
2. Use the coder agent to check the implementation against the corrected plan and commit any fix it
   needs (it commits nothing if the implementation already satisfies the plan).
3. Use the tester agent to re-run its checks against the corrected plan and rewrite
   .factory/test-report.md, ending with a line "## Result: PASS" or "## Result: FAIL" (and, for FAIL, a
   "## Failure reason:" line). The tester judges the criteria exactly as written in the corrected plan.`;

export const TEST_FAILURE_PROMPT = `.factory/test-report.md is missing, unparseable, or reports FAIL. Use
the coder agent to fix the implementation (not the tests) per the failures listed
(or, if there is no report, to make sure the work is complete and committed), then
use the tester agent to re-run the tests and rewrite .factory/test-report.md ending
with a line "## Result: PASS" or "## Result: FAIL".`;

// reportText: the contents of .factory/test-report.md, or "" when there is none.
export function fixStep(reportText) {
  const reason = parseFailureReason(reportText);
  if (reason === "plan error") {
    return {
      kind: "plan-error",
      prompt: PLAN_ERROR_PROMPT,
    };
  }
  return {
    kind: "fix",
    prompt: TEST_FAILURE_PROMPT,
  };
}

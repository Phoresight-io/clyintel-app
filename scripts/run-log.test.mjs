// Run with: node --test scripts/run-log.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestResult } from "./run-log.mjs";

test("parseTestResult: only an explicit result counts; last one wins; fails closed", () => {
  const cases = [
    [undefined, "none"],
    ["", "none"],
    ["## Result: PASS\n", "PASS"],
    ["## Result: FAIL\n", "FAIL"],
    ["## Result: **PASS**\n", "PASS"],
    ["## result: pass", "PASS"],
    ["## Result: PASS | FAIL\n", "unknown"], // unfilled template line is not a result
    ["## Result: FAIL | PASS", "unknown"],
    ["## Result: PASS | FAIL\n## Result: PASS", "PASS"],
    ["## Result: FAIL\n...\n## Result: PASS\n", "PASS"],
    ["## Result: PASS\n...\n## Result: FAIL\n", "FAIL"],
    ["Ran out of turns while writing tests", "unknown"],
  ];
  for (const [text, want] of cases) assert.equal(parseTestResult(text), want, JSON.stringify(text));
});

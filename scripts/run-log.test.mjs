// Run with: node --test scripts/run-log.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestResult, parseFailureReason, reviewVerdict, writeRunLog } from "./run-log.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("reviewVerdict: only an explicit VERDICT line counts (bold allowed); prose never does", () => {
  assert.equal(reviewVerdict("Looks fine.\n**VERDICT: APPROVE**"), "APPROVE");
  assert.equal(reviewVerdict("notes\n__VERDICT: REQUEST CHANGES__\n"), "REQUEST CHANGES");
  assert.equal(reviewVerdict("VERDICT: BLOCK"), "BLOCK");
  assert.equal(reviewVerdict("VERDICT: BLOCK\nlater\nVERDICT: APPROVE"), "APPROVE"); // last wins
  // prose without a VERDICT line is "unknown", never a guess
  assert.equal(reviewVerdict("I can't approve this."), "unknown");
  assert.equal(reviewVerdict("This is a disapprove situation."), "unknown");
  assert.equal(reviewVerdict("No blockers; this is a code block. I would approve."), "unknown");
  assert.equal(reviewVerdict("This must BLOCK the merge."), "unknown");
  assert.equal(reviewVerdict(""), "unknown");
});

test("writeRunLog: the committed record holds a hash of the brief, never the brief", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const brief = "remind Acme Corp about overdue invoice #1234 ($9,800)";
    const rec = writeRunLog({ brief, reviewSummary: "VERDICT: APPROVE" });
    const line = readFileSync(join(dir, ".factory/runs/run-local.json"), "utf8");
    assert.doesNotMatch(line, /Acme|1234|9,800/);
    assert.equal(rec.brief, undefined);
    assert.match(rec.brief_sha256, /^[0-9a-f]{12}$/);
    assert.equal(rec.brief_chars, brief.length);
    assert.equal(rec.review_verdict, "APPROVE");
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRunLog: turns, cost and guard denials from the SDK results are written (and default to 0)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const rec = writeRunLog({ brief: "x", reviewSummary: "", usage: { turns: 7, cost: 0.123456, denials: 2 } });
    const onDisk = JSON.parse(readFileSync(join(dir, ".factory/runs/run-local.json"), "utf8"));
    assert.deepEqual([onDisk.num_turns, onDisk.total_cost_usd, onDisk.guard_denials], [7, 0.1235, 2]);
    assert.equal(rec.total_cost_usd, 0.1235);
    const bare = writeRunLog({ brief: "x", reviewSummary: "" });
    assert.deepEqual([bare.num_turns, bare.total_cost_usd, bare.guard_denials], [0, 0, 0]);
    const junk = writeRunLog({ brief: "x", reviewSummary: "", usage: { turns: "NaN", cost: undefined, denials: null } });
    assert.deepEqual([junk.num_turns, junk.total_cost_usd, junk.guard_denials], [0, 0, 0]);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseFailureReason: only the three exact reasons count; the unfilled template line and prose do not", () => {
  assert.equal(parseFailureReason("## Result: FAIL\n## Failure reason: plan error\n## Coverage"), "plan error");
  assert.equal(parseFailureReason("## Failure reason: **Plan Error**"), "plan error");
  assert.equal(parseFailureReason("  ## Failure reason: test failure  "), "test failure");
  assert.equal(parseFailureReason("## Failure reason: could not run the suite"), "could not run the suite");
  // the last explicit line wins
  assert.equal(parseFailureReason("## Failure reason: plan error\n...\n## Failure reason: test failure"), "test failure");
  // not a reason: the template, a made-up reason, prose, an empty report
  assert.equal(parseFailureReason("## Failure reason: plan error | test failure | could not run the suite   (only when FAIL)"), "unknown");
  assert.equal(parseFailureReason("## Failure reason: the plan was wrong"), "unknown");
  assert.equal(parseFailureReason("This is a plan error, I think."), "unknown");
  assert.equal(parseFailureReason(""), "unknown");
  assert.equal(parseFailureReason(undefined), "unknown");
});

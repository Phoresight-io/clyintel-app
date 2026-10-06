// Run with: node --test scripts/factory-notes.test.mjs
//
// The agents' "## Slack update" notes: extraction, the needs_you flag, the verdict enum, the file the
// orchestrator writes (and where), and the role guard keeping agents out of that directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTES_DIR, NOTES_FILE, MAX_NOTE_CHARS, AGENTS, extractNote, needsYou, parseVerdict, createNotes, setNote, setReview, writeNotes,
} from "./factory-notes.mjs";
import { decide, touchesNotes } from "./role-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const section = (body) => `# Plan: x\n\n## Goal\nstuff\n\n## Slack update\n${body}\n`;

test("extractNote: a present section is returned trimmed; a missing or empty one is null", () => {
  assert.equal(extractNote(section("Planned two tasks.")), "Planned two tasks.");
  assert.equal(extractNote(section("  \n  Planned two tasks.  \n\n")), "Planned two tasks.");
  assert.equal(extractNote("# Plan: x\n\n## Goal\nstuff\n"), null);
  assert.equal(extractNote(section("")), null);
  assert.equal(extractNote(section("   \n  ")), null);
  assert.equal(extractNote(undefined), null);
  assert.equal(extractNote(null), null);
  assert.equal(extractNote(42), null);
  assert.equal(extractNote(""), null);
  // heading wording: case and spacing are forgiving, the level is not (a "### Slack update" is not the section)
  assert.equal(extractNote("## slack UPDATE\nok"), "ok");
  assert.equal(extractNote("### Slack update\nnope"), null);
  assert.equal(extractNote("## Slack updates\nnope"), null);
  assert.equal(extractNote("text ## Slack update\nnope"), null);
});

test("extractNote: the section ends at the next heading or at the reviewer's VERDICT line", () => {
  assert.equal(extractNote("## Slack update\nfirst\nsecond\n## Risk flags\nnot part"), "first\nsecond");
  assert.equal(extractNote("## Slack update\nfirst\n### Sub\nnot part"), "first");
  assert.equal(extractNote("## Slack update\nReview done.\n\nVERDICT: APPROVE"), "Review done.");
  assert.equal(extractNote("## Slack update\nReview done.\n**VERDICT:** BLOCK\n"), "Review done.");
  assert.equal(extractNote("## Review: x\n### Verdict: APPROVE\n\n## Slack update\nLooks fine.\nVERDICT: APPROVE"), "Looks fine.");
});

test("extractNote: more than 300 characters is cut to exactly 300 (code points), before anything else sees it", () => {
  const long = "a".repeat(MAX_NOTE_CHARS + 50);
  assert.equal(MAX_NOTE_CHARS, 300);
  assert.equal(extractNote(section(long)), "a".repeat(300));
  // code points, not UTF-16 units: an emoji is never cut in half
  const emoji = extractNote(section("🔥".repeat(400)));
  assert.equal([...emoji].length, 300);
  assert.ok(!emoji.includes("�") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
  // exactly 300 is kept whole
  assert.equal(extractNote(section("b".repeat(300))), "b".repeat(300));
  // control characters are not special to the extractor: the cap counts everything
  assert.equal([...extractNote(section("<".repeat(500)))].length, 300);
});

test("extractNote: a duplicated section resolves to the LAST one", () => {
  const text = "## Slack update\nquoted template\n\n## Goal\nx\n\n## Slack update\nthe real one\n";
  assert.equal(extractNote(text), "the real one");
  // a last section that is empty counts as none: an earlier one is not resurrected
  assert.equal(extractNote("## Slack update\nfirst\n\n## Slack update\n\n"), null);
});

test("needsYou: only the FIRST line of the extracted, capped section counts", () => {
  assert.equal(needsYou("Needs you: pick a plan; two fit"), true);
  assert.equal(needsYou("needs you:   confirm the schema change"), true);
  assert.equal(needsYou("Needs you: x\nand more"), true);
  assert.equal(needsYou("Done.\nNeeds you: nope, line two"), false);
  assert.equal(needsYou("All good. Needs you: mid-line"), false);
  assert.equal(needsYou("Needs you:"), false); // nothing asked
  assert.equal(needsYou("Needs you:   \nsecond"), false);
  assert.equal(needsYou(" Needs you: leading space"), false); // the note is already trimmed; a space inside is not line 1 start
  assert.equal(needsYou("Needs your attention"), false);
  assert.equal(needsYou(""), false);
  assert.equal(needsYou(undefined), false);
});

test("setNote: needs_you is read from the section only, never from elsewhere in the artifact", () => {
  const artifact = [
    "# Plan: x", "", "## Risk flags", "Needs you: this is in Risk flags, not the Slack update", "",
    "## Slack update", "Planned. Needs you: mid-line does not count", "",
  ].join("\n");
  const s = setNote(createNotes(), "planner", artifact);
  assert.deepEqual(s.notes, [{ agent: "planner", text: "Planned. Needs you: mid-line does not count", needs_you: false }]);
  const t = setNote(createNotes(), "planner", `${artifact}\n## Slack update\nNeeds you: choose A or B\nbecause both fit`);
  assert.equal(t.notes[0].needs_you, true);
  assert.equal(t.notes[0].text, "Needs you: choose A or B\nbecause both fit");
  // a line-1 "Needs you:" that is cut off by the cap still counts (the cap keeps the start of the line)
  const u = setNote(createNotes(), "coder", section("Needs you: " + "x".repeat(400)));
  assert.equal(u.notes[0].needs_you, true);
  assert.equal([...u.notes[0].text].length, 300);
});

test("parseVerdict: only an explicit VERDICT line in the enum counts; everything else is null", () => {
  assert.equal(parseVerdict("review...\nVERDICT: APPROVE"), "APPROVE");
  assert.equal(parseVerdict("review...\nVERDICT: REQUEST CHANGES"), "REQUEST CHANGES");
  assert.equal(parseVerdict("**VERDICT: BLOCK**"), "BLOCK");
  assert.equal(parseVerdict("VERDICT: APPROVE\nmore\nVERDICT: BLOCK"), "BLOCK"); // last wins, like the run log
  assert.equal(parseVerdict("VERDICT: MAYBE"), null);
  assert.equal(parseVerdict("VERDICT: APPROVED"), null);
  assert.equal(parseVerdict("I can't approve this"), null);
  assert.equal(parseVerdict("### Verdict: APPROVE"), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict(undefined), null); // the reviewer did not run
  assert.equal(parseVerdict(null), null);
});

test("setNote / setReview: one note per known agent, in order, replaced on a re-run, removed when the section is gone", () => {
  const s = createNotes();
  setNote(s, "tester", section("Tests pass."));
  setNote(s, "planner", section("Plan ready."));
  setNote(s, "mallory", section("evil")); // not an agent
  assert.deepEqual(s.notes.map((n) => n.agent), ["planner", "tester"]);
  setNote(s, "tester", section("Tests fail on tenant scoping."));
  assert.equal(s.notes.length, 2);
  assert.equal(s.notes.find((n) => n.agent === "tester").text, "Tests fail on tenant scoping.");
  setNote(s, "planner", "# Plan without a section");
  assert.deepEqual(s.notes.map((n) => n.agent), ["tester"]);
  assert.equal(s.verdict, null);
  setReview(s, "## Slack update\nBlocked: secret in diff.\nVERDICT: BLOCK");
  assert.equal(s.verdict, "BLOCK");
  assert.equal(s.notes.at(-1).agent, "reviewer");
  assert.equal(s.notes.at(-1).text, "Blocked: secret in diff.");
  assert.deepEqual(AGENTS, ["planner", "coder", "tester", "reviewer"]);
});

test("writeNotes: writes {notes, verdict} atomically into an existing directory, and does nothing (and never throws) otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  try {
    const s = createNotes();
    setNote(s, "coder", section("Built it."));
    assert.equal(writeNotes(s, dir), true);
    assert.deepEqual(readdirSync(dir), [NOTES_FILE], "no temp file left behind");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, NOTES_FILE), "utf8")), {
      notes: [{ agent: "coder", text: "Built it.", needs_you: false }], verdict: null,
    });
    setReview(s, "## Slack update\nOK\nVERDICT: APPROVE");
    writeNotes(s, dir);
    assert.equal(JSON.parse(readFileSync(join(dir, NOTES_FILE), "utf8")).verdict, "APPROVE");
    // a file is not a directory; a missing directory is a no-op (an older workflow without the mount)
    writeFileSync(join(dir, "plain"), "x");
    assert.equal(writeNotes(s, join(dir, "plain", "nested")), false);
    assert.equal(writeNotes(s, join(dir, "missing")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // the real location is outside the repo copy, so `git add -A` can never see it
  assert.equal(NOTES_DIR, "/notes");
  assert.ok(!NOTES_DIR.startsWith(REPO) && !"/work/repo".startsWith(NOTES_DIR));
});

// ---- role guard: agents do not write to the notes directory

const DECIDE = (agent, tool, args) =>
  decide({ tool_name: tool, tool_input: args, agent_id: "a1", agent_type: agent }, "/work/repo");
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny";

test("role guard: no agent may Write or Edit under /notes, however the path is spelled", () => {
  for (const agent of ["planner", "coder", "tester"]) {
    for (const tool of ["Write", "Edit"]) {
      for (const p of ["/notes/factory-notes.json", "/notes", "/notes/../notes/x", "//notes/x", "/work/repo/../../notes/factory-notes.json", "/notes/./factory-notes.json",
        // relative paths resolve against the repo root (/work/repo): the orchestrator's working directory
        "../../notes/factory-notes.json", "../../notes", "./../../notes/x", "clyintel/../../../notes/x"]) {
        if (agent === "planner" && tool === "Edit") continue; // the planner has no Edit at all (denied for that reason)
        assert.ok(denied(DECIDE(agent, tool, { file_path: p })), `${agent} ${tool} ${p}`);
      }
    }
  }
  assert.match(DECIDE("coder", "Write", { file_path: "/notes/factory-notes.json" }).hookSpecificOutput.permissionDecisionReason, /orchestrator/);
});

test("role guard: coder and tester Bash that names /notes is refused; ordinary paths that merely contain 'notes' are not", () => {
  for (const agent of ["coder", "tester"]) {
    for (const cmd of [
      "echo '{}' > /notes/factory-notes.json", "cp x /notes/", "ls /notes", "cat /notes/factory-notes.json", "rm -rf /notes", "tee /notes/x < y",
      "cd /tmp && echo hi >/notes/f", "VAR=/notes/x; echo > $VAR", "(echo hi) 2>&1 | tee \"/notes/factory-notes.json\"",
    ]) assert.ok(denied(DECIDE(agent, "Bash", { command: cmd })), `${agent}: ${cmd}`);
    for (const cmd of ["ls clyintel/app/notes", "cat /work/repo/clyintel/app/notes/page.tsx", "git add clyintel/lib/notes.ts", "npx vitest run lib/notes", "echo notes > docs/notes.md", "cat ./notes/a.md", "ls /notes-archive"])
      assert.ok(!denied(DECIDE(agent, "Bash", { command: cmd })), `${agent}: ${cmd}`);
  }
  assert.ok(!denied(DECIDE("coder", "Write", { file_path: "/work/repo/clyintel/app/notes/page.tsx" })));
  assert.ok(!denied(DECIDE("coder", "Write", { file_path: "clyintel/app/notes/page.tsx" })), "a relative path inside the repo is fine");
  assert.ok(!denied(DECIDE("coder", "Write", { file_path: "notes/page.tsx" })), "a repo-level notes/ directory is not /notes");
  // the guard itself, not just the role rules around it: relative paths resolve against the root it is given
  assert.equal(touchesNotes("Write", { file_path: "../../notes/f" }, "/work/repo"), true);
  assert.equal(touchesNotes("Edit", { file_path: "../notes/f" }, "/work/repo"), false, "/work/notes is not /notes");
  assert.equal(touchesNotes("Write", { file_path: "notes/f" }, "/work/repo"), false);
  assert.equal(touchesNotes("Read", { file_path: "/notes/x" }), false); // reading is not writing
});

// ---- the orchestrator wires it in without ever naming Slack

test("orchestrator: notes are saved after every stage and in the failure path, and the file is the orchestrator's alone", () => {
  const src = readFileSync(join(HERE, "d3-orchestrator.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /from "\.\/factory-notes\.mjs"/);
  assert.equal([...src.matchAll(/\bsaveNotes\(\)/g)].length, 4, "after the first run, after the fix, after the review, and on failure");
  assert.match(src, /setReview\(notes, verdict\)/);
  assert.match(src, /catch \(err\) \{\n  console\.error\(err\);\n  saveNotes\(\);/);
  assert.doesNotMatch(src, /slack/i);
});

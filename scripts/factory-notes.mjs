import {
  writeFileSync, renameSync, existsSync, lstatSync, mkdirSync, rmSync, openSync, fstatSync, readFileSync, closeSync, constants,
} from "node:fs";
import { join } from "node:path";
import { reviewVerdict } from "./run-log.mjs";

// Agent notes: the short "## Slack update" section each agent ends its artifact with, collected by
// the orchestrator into factory-notes.json for the notify-agents job to post as thread replies.
//
// The file lives in NOTES_DIR, a directory the workflow mounts into the agent container OUTSIDE the
// repo copy, so `git add -A` can never commit it. Only the orchestrator writes there (role-guard.mjs
// refuses agent tool writes to it). It is still UNTRUSTED: an injected coder's Bash can reach the
// same mount, so the notify-agents job re-validates everything (agent names, verdict enum, size,
// text length, escaping) and never believes this file.
//
// Pure stdlib. Every function here is non-throwing EXCEPT resetReviewSlot, which throws on purpose: an
// unwritable or unremovable .factory just before the review is treated as tampering (a coder can write
// almost anywhere), so the run aborts, fail closed, rather than reviewing against a slot it cannot clear.
// The orchestrator turns that throw into the fixed REVIEW_SLOT_FAILED text below; nothing from the
// filesystem error reaches the failure message.

export const NOTES_DIR = "/notes";
export const NOTES_FILE = "factory-notes.json";
export const MAX_NOTE_CHARS = 300;
export const AGENTS = ["planner", "coder", "tester", "reviewer"];

// The section runs from its heading to the next heading, or to the reviewer's closing VERDICT line.
// The LAST section wins (like the other parsers here), so a template quoted earlier in the artifact
// cannot shadow the real one. Capped (in code points) BEFORE anything else looks at it. Returns the
// trimmed, capped text, or null when there is no section or it is empty.
export function extractNote(artifact) {
  if (typeof artifact !== "string") return null;
  const lines = artifact.split(/\r?\n/);
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*##[ \t]+Slack update[ \t]*$/i.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]*#{1,6}[ \t]/.test(lines[j]) || /^[\s*_]*VERDICT:/i.test(lines[j])) break;
      body.push(lines[j]);
    }
    section = body.join("\n");
  }
  if (section === null) return null;
  const text = [...section.trim()].slice(0, MAX_NOTE_CHARS).join("").trim();
  return text === "" ? null : text;
}

// "Needs you:" counts ONLY on the first line of the extracted, capped section, followed by something.
// Anywhere else in the artifact it means nothing.
export function needsYou(note) {
  if (typeof note !== "string") return false;
  return /^Needs you:[ \t]*\S/i.test(note.split("\n")[0]);
}

// The reviewer's verdict as an enum, or null (no explicit VERDICT line, or the reviewer did not run).
export function parseVerdict(reviewText) {
  const v = reviewVerdict(typeof reviewText === "string" ? reviewText : "");
  return v === "unknown" ? null : v;
}

export const createNotes = () => ({ notes: [], verdict: null });

// ---- the reviewer's file

// The reviewer writes its review (ending with its "## Slack update" section and the VERDICT line) to
// .factory/review.md; role-guard lets it write that one real path and nothing else. The orchestrator
// reads the note and the verdict from the file, and only falls back to the top-level session's reply
// when the file is missing or unusable.
export const REVIEW_FILE = "review.md";
export const MAX_REVIEW_BYTES = 64 * 1024;
export const REVIEW_SLOT_FAILED = "review slot reset failed: .factory not writable (possible tampering)";

const isRealDir = (p) => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

// Run just before the review stage. Neutralises anything an earlier agent (the coder can write almost
// anywhere) left where the reviewer's file goes, without ever following a link:
//   - .factory that is not a real directory (a symlink, a file) is removed and recreated as a directory;
//   - a review.md that is a file, a link or a directory is removed, so only a file the reviewer writes
//     now can be read, never a planted "VERDICT: APPROVE".
// THROWS when it cannot do either (EACCES, EBUSY, ENOTDIR, ...): see the header. Fail closed, by design.
// A real .factory is kept as is (it holds the plan, the build notes and the test report).
export function resetReviewSlot(dir = ".factory") {
  const done = { dirReplaced: false, fileRemoved: false };
  if (!isRealDir(dir)) {
    rmSync(dir, { recursive: true, force: true }); // a link is unlinked, its target untouched
    mkdirSync(dir, { recursive: true });
    done.dirReplaced = true;
  }
  const file = join(dir, REVIEW_FILE);
  try {
    lstatSync(file);
    rmSync(file, { recursive: true, force: true });
    done.fileRemoved = true;
  } catch {}
  return done;
}

// The review file's text, or null when it cannot be trusted as the reviewer's: .factory not a real
// directory, the file missing, a link (O_NOFOLLOW), not a regular file (O_NONBLOCK, so a FIFO cannot
// hang the open), hard-linked, or over the size cap. Checked on the open descriptor, not the path.
export function readReviewFile(dir = ".factory") {
  try {
    if (!isRealDir(dir)) return null;
    const fd = openSync(join(dir, REVIEW_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink > 1 || st.size > MAX_REVIEW_BYTES) return null;
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// File first, field by field: the note and the verdict each come from the file when it has one, else
// from the reply; a verdict neither has is null. `text` is what the run record's verdict is read
// from (the file when it carries a verdict, else the reply); writeRunLog reduces it to the enum.
export function reviewSources({ file, reply } = {}) {
  const f = typeof file === "string" ? file : "";
  const r = typeof reply === "string" ? reply : "";
  const fileVerdict = parseVerdict(f);
  return {
    note: extractNote(f) ?? extractNote(r),
    verdict: fileVerdict ?? parseVerdict(r),
    text: fileVerdict !== null ? f : r,
  };
}

// Sets (or, when the artifact has no usable section any more, removes) one agent's note.
export function setNote(state, agent, artifact) {
  if (!AGENTS.includes(agent)) return state;
  state.notes = state.notes.filter((n) => n.agent !== agent);
  const text = extractNote(artifact);
  if (text !== null) state.notes.push({ agent, text, needs_you: needsYou(text) });
  state.notes.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent));
  return state;
}

// The reviewer's note and verdict, from its file with the reply as the fallback (reviewSources).
export function setReviewSources(state, sources) {
  const review = reviewSources(sources);
  state.notes = state.notes.filter((n) => n.agent !== "reviewer");
  if (review.note !== null) state.notes.push({ agent: "reviewer", text: review.note, needs_you: needsYou(review.note) });
  state.notes.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent));
  state.verdict = review.verdict;
  return state;
}

// Both from one text (the old behaviour: the top-level session's reply).
export const setReview = (state, reviewText) => setReviewSources(state, { reply: reviewText });

// Writes {notes, verdict} to <dir>/factory-notes.json, atomically (write, then rename), but only when
// the directory exists: under a workflow that does not mount it this is a no-op. Returns whether it wrote.
export function writeNotes(state, dir = NOTES_DIR) {
  try {
    if (!existsSync(dir)) return false;
    const tmp = join(dir, `.${NOTES_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify({ notes: state.notes, verdict: state.verdict }) + "\n");
    renameSync(tmp, join(dir, NOTES_FILE));
    return true;
  } catch {
    return false;
  }
}

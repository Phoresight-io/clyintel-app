import { writeFileSync, renameSync, existsSync } from "node:fs";
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
// Pure stdlib. No function here throws into the pipeline.

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

// Sets (or, when the artifact has no usable section any more, removes) one agent's note.
export function setNote(state, agent, artifact) {
  if (!AGENTS.includes(agent)) return state;
  state.notes = state.notes.filter((n) => n.agent !== agent);
  const text = extractNote(artifact);
  if (text !== null) state.notes.push({ agent, text, needs_you: needsYou(text) });
  state.notes.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent));
  return state;
}

// The reviewer's note and verdict both come from its final message.
export function setReview(state, reviewText) {
  setNote(state, "reviewer", reviewText);
  state.verdict = parseVerdict(reviewText);
  return state;
}

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

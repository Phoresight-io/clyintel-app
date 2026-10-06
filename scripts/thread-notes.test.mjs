// Run with: node --test scripts/thread-notes.test.mjs
//
// The Slack thread of a factory run, as d3-factory.yml defines it. The notify-agents job's real script
// is run (bash + jq) against a stub curl, and the workflow's structure is checked:
//   - the notes file is untrusted: agent names, verdict enum, size and length caps, escaping;
//   - nothing an agent wrote reaches a shell string or a curl argument, and every post has previews off;
//   - the tag is added by the workflow, only for a valid Slack user id, only when it should be;
//   - a Slack failure never blocks a PR and never raises a failure alarm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/d3-factory.yml"), "utf8");
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

const JOBS = ["prepare", "notify-start", "pipeline", "notify-agents", "publish", "notify-failure"];
function job(name) {
  const i = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(i >= 0, `job ${name} not found`);
  const next = JOBS.map((j) => WORKFLOW.indexOf(`\n  ${j}:\n`)).filter((k) => k > i).sort((a, b) => a - b)[0] ?? WORKFLOW.length;
  return WORKFLOW.slice(i, next);
}
const codeOnly = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
function stepScript(name) {
  const lines = WORKFLOW.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `step not found: ${name}`);
  const r = lines.findIndex((l, k) => k > i && /^\s+run: \|\s*$/.test(l));
  const indent = lines[r].match(/^\s*/)[0].length;
  const body = [];
  for (let k = r + 1; k < lines.length; k++) {
    if (lines[k].trim() === "") { body.push(""); continue; }
    if (lines[k].match(/^\s*/)[0].length <= indent) break;
    body.push(lines[k].slice(indent + 2));
  }
  return body.join("\n");
}
const AGENTS_STEP = "Post the agents' notes in the run's thread";
const START_STEP = "Tell Slack the run started";
const FAILURE_STEP = "Tell Slack the run failed";

// ---- a sandbox with a stub curl: argv to curl.calls, each stdin payload to post.<n>.json

function sandbox({ curlExit = 0, response = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tn-"));
  const bin = join(root, "bin");
  const cwd = join(root, "cwd");
  mkdirSync(bin);
  mkdirSync(cwd);
  writeFileSync(join(bin, "curl"), `#!/bin/bash
printf '%s\\0' "$@" >> "${root}/curl.calls"; echo >> "${root}/curl.calls"
n=$(( $(cat "${root}/n" 2>/dev/null || echo 0) + 1 )); echo $n > "${root}/n"
cat > "${root}/post.$n.json"
printf '%s' ${JSON.stringify(response)}
exit ${curlExit}
`);
  chmodSync(join(bin, "curl"), 0o755);
  return { root, bin, cwd };
}
const postsOf = (root) => {
  const n = existsSync(join(root, "n")) ? Number(readFileSync(join(root, "n"), "utf8")) : 0;
  return Array.from({ length: n }, (_, i) => JSON.parse(readFileSync(join(root, `post.${i + 1}.json`), "utf8")));
};
const callsOf = (root) =>
  existsSync(join(root, "curl.calls")) ? readFileSync(join(root, "curl.calls"), "utf8").split("\0\n").filter(Boolean).map((l) => l.split("\0")) : [];
const run = (w, step, env) =>
  spawnSync("bash", ["-e", "-c", stepScript(step)], { cwd: w.cwd, env: { PATH: `${w.bin}:${process.env.PATH}`, HOME: w.root, ...env }, encoding: "utf8" });

const BASE_ENV = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL: "C0CHAN", SLACK_USER: "U0ABC123", THREAD_TS: "1700000000.000100" };
const note = (agent, text, extra = {}) => ({ agent, text, needs_you: false, ...extra });
const FOUR = [note("planner", "Planned."), note("coder", "Built."), note("tester", "Tested."), note("reviewer", "Reviewed.")];

// Runs notify-agents on a notes file. `notes` is serialised; `raw` is written as is; `setup(file)` may replace it.
function agents({ notes, raw, setup, env = {}, curlExit = 0 } = {}) {
  const w = sandbox({ curlExit });
  mkdirSync(join(w.root, "notes"));
  const file = join(w.root, "notes", "factory-notes.json");
  if (raw !== undefined) writeFileSync(file, raw);
  else if (notes !== undefined) writeFileSync(file, JSON.stringify(notes));
  if (setup) setup(file, w);
  const r = run(w, AGENTS_STEP, { ...BASE_ENV, NOTES_FILE: file, ...env });
  return { ...r, w, code: r.status, posts: postsOf(w.root), calls: callsOf(w.root), done: () => rmSync(w.root, RM) };
}
const withRun = (opts, fn) => { const r = agents(opts); try { return fn(r); } finally { r.done(); } };
const nothingPosted = (opts, why) => withRun(opts, (r) => { assert.equal(r.code, 0, `${why}: ${r.stderr}`); assert.equal(r.posts.length, 0, `${why}: posted ${JSON.stringify(r.posts)}`); });

// ---- notify-agents: the happy path

test("notify-agents: one threaded reply per agent, in order, with its label, no previews", () => {
  withRun({ notes: { notes: [FOUR[3], FOUR[1], FOUR[0], FOUR[2]], verdict: "APPROVE" } }, (r) => {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.posts.map((p) => p.text), ["🧭 Planner: Planned.", "🔨 Coder: Built.", "🧪 Tester: Tested.", "🔍 Reviewer: Reviewed."]);
    for (const p of r.posts) {
      assert.equal(p.channel, "C0CHAN");
      assert.equal(p.thread_ts, "1700000000.000100");
      assert.equal(p.unfurl_links, false);
      assert.equal(p.unfurl_media, false);
      assert.deepEqual(Object.keys(p).sort(), ["channel", "text", "thread_ts", "unfurl_links", "unfurl_media"]);
    }
    // the request itself: a fixed argument list, the payload on stdin, the token in a header
    for (const c of r.calls) {
      assert.deepEqual(c.slice(0, 1), ["-s"]);
      assert.ok(c.includes("https://slack.com/api/chat.postMessage"));
      assert.equal(c[c.indexOf("--data") + 1], "@-");
      assert.ok(!c.includes("-d"));
    }
  });
});

test("notify-agents: only the notes that exist are posted, and the last note per agent counts", () => {
  withRun({ notes: { notes: [note("planner", "old"), note("tester", "Tested."), note("planner", "new")], verdict: null } }, (r) => {
    assert.deepEqual(r.posts.map((p) => p.text), ["🧭 Planner: new", "🧪 Tester: Tested."]);
  });
  nothingPosted({ notes: { notes: [], verdict: null } }, "empty notes");
  nothingPosted({ notes: {} }, "no notes key");
});

test("notify-agents: no thread_ts (or one that is not a Slack ts) posts top-level instead", () => {
  for (const ts of ["", "1700000000", "17000.00001; rm -rf /", "abc.def", "1700000000.000100\n<!channel>", " 1700000000.000100"]) {
    withRun({ notes: { notes: [FOUR[0]], verdict: null }, env: { THREAD_TS: ts } }, (r) => {
      assert.equal(r.posts.length, 1, JSON.stringify(ts));
      assert.ok(!("thread_ts" in r.posts[0]), JSON.stringify(ts));
      assert.equal(r.posts[0].unfurl_links, false);
    });
  }
});

test("notify-agents: no token, no channel, or no notes file means nothing is posted (and the job still succeeds)", () => {
  nothingPosted({ notes: { notes: FOUR }, env: { SLACK_BOT_TOKEN: "" } }, "no token");
  nothingPosted({ notes: { notes: FOUR }, env: { SLACK_CHANNEL: "" } }, "no channel: an Actions-tab run with D3_DEFAULT_CHANNEL unset");
  withRun({ setup: () => {} }, (r) => { assert.equal(r.code, 0); assert.equal(r.posts.length, 0); }); // artifact missing
});

// ---- notify-agents: the notes are untrusted

test("notify-agents: Slack control sequences in a note are escaped, never posted raw", () => {
  const hostile = [
    "<!channel> wake up", "<!here> and <!everyone>", "hi <@U0EVIL999> and <@W0EVIL999>", "<https://evil.example/x|click me>",
    "<#C0SECRET|private> <!subteam^S123> <mailto:a@b.c|mail>", "a & b < c > d &amp; &lt;!channel&gt;",
  ];
  const escaped = [
    "&lt;!channel&gt; wake up", "&lt;!here&gt; and &lt;!everyone&gt;", "hi &lt;@U0EVIL999&gt; and &lt;@W0EVIL999&gt;", "&lt;https://evil.example/x|click me&gt;",
    "&lt;#C0SECRET|private&gt; &lt;!subteam^S123&gt; &lt;mailto:a@b.c|mail&gt;", "a &amp; b &lt; c &gt; d &amp;amp; &amp;lt;!channel&amp;gt;",
  ];
  hostile.forEach((text, i) => {
    for (const agent of ["planner", "coder", "tester", "reviewer"]) {
      withRun({ notes: { notes: [note(agent, text)], verdict: null } }, (r) => {
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.posts.length, 1);
        const body = r.posts[0].text.replace(/^[^:]+: /, "");
        assert.equal(body, escaped[i], text);
        assert.doesNotMatch(r.posts[0].text, /<|>/, text);
      });
    }
  });
  // the same strings in a note of a run that is tagging: the ONLY "<@" in the post is the workflow's own tag
  withRun({ notes: { notes: [note("reviewer", "<@U0EVIL999> <!channel>", { needs_you: true })], verdict: "BLOCK" } }, (r) => {
    assert.equal(r.posts[0].text, "🔍 Reviewer: <@U0ABC123> &lt;@U0EVIL999&gt; &lt;!channel&gt;");
    assert.equal([...r.posts[0].text.matchAll(/</g)].length, 1);
  });
});

test("notify-agents: a note is capped at 300 characters BEFORE it is escaped", () => {
  for (const [ch, esc] of [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"]]) {
    withRun({ notes: { notes: [note("planner", ch.repeat(300)), note("coder", ch.repeat(1000))], verdict: null } }, (r) => {
      for (const p of r.posts) {
        const body = p.text.replace(/^[^:]+: /, "");
        assert.equal(body, esc.repeat(300), `${ch}: 300 characters, each escaped once, no cut-off entity`);
        assert.doesNotMatch(body, /&(?!amp;|lt;|gt;)/);
      }
    });
  }
  // a mixed 300-character text full of & < >, with a tail that must be dropped
  const mixed = "a&b<c>d".repeat(60); // 420 chars
  withRun({ notes: { notes: [note("planner", mixed)], verdict: null } }, (r) => {
    const expected = [...mixed].slice(0, 300).join("").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    assert.equal(r.posts[0].text, `🧭 Planner: ${expected}`);
  });
  // emoji count as one character each and are never split
  withRun({ notes: { notes: [note("planner", "🔥".repeat(500))], verdict: null } }, (r) => {
    assert.equal(r.posts[0].text, `🧭 Planner: ${"🔥".repeat(300)}`);
  });
});

test("notify-agents: a bare https:// link is posted as plain text, and the post has previews off", () => {
  withRun({ notes: { notes: [note("tester", "see https://evil.example/leak?d=secret for details")], verdict: null } }, (r) => {
    assert.equal(r.posts[0].text, "🧪 Tester: see https://evil.example/leak?d=secret for details");
    assert.equal(r.posts[0].unfurl_links, false);
    assert.equal(r.posts[0].unfurl_media, false);
  });
});

test("notify-agents: unknown agent names are dropped, whatever their text", () => {
  const bad = ["admin", "Planner", "PLANNER", "planner ", "reviewer\n", "", "__proto__", "orchestrator", 5, null, ["planner"], { a: 1 }];
  withRun({ notes: { notes: [...bad.map((a) => ({ agent: a, text: "evil", needs_you: true })), note("coder", "fine")], verdict: "BLOCK" } }, (r) => {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.posts.map((p) => p.text), ["🔨 Coder: fine"]);
  });
  // malformed entries inside the array are skipped, they do not stop the others
  withRun({ notes: { notes: ["str", 7, null, [], { agent: "planner" }, { agent: "planner", text: 5 }, { agent: "planner", text: ["x"] }, note("tester", "ok")], verdict: null } }, (r) => {
    assert.deepEqual(r.posts.map((p) => p.text), ["🧪 Tester: ok"]);
  });
});

test("notify-agents: a verdict outside the enum rejects the whole file", () => {
  for (const verdict of ["approve", "APPROVED", "Request Changes", "BLOCK ", "MERGE", "", 1, true, ["BLOCK"], { v: "BLOCK" }, "APPROVE\nBLOCK"]) {
    nothingPosted({ notes: { notes: FOUR, verdict } }, `verdict ${JSON.stringify(verdict)}`);
  }
  for (const verdict of ["APPROVE", "REQUEST CHANGES", "BLOCK", null]) {
    withRun({ notes: { notes: FOUR, verdict } }, (r) => assert.equal(r.posts.length, 4, String(verdict)));
  }
  withRun({ notes: { notes: FOUR } }, (r) => assert.equal(r.posts.length, 4, "no verdict key at all is null"));
});

test("notify-agents: an oversized file, invalid JSON, a link or the wrong shape is rejected, never partly posted", () => {
  nothingPosted({ raw: JSON.stringify({ notes: [note("planner", "x".repeat(9000))], verdict: null }) }, "over 8 KB");
  nothingPosted({ raw: JSON.stringify({ notes: [note("planner", "ok")], verdict: null }) + " ".repeat(9000) }, "padded over 8 KB");
  nothingPosted({ raw: "not json" }, "not json");
  nothingPosted({ raw: '{"notes": [' }, "truncated");
  nothingPosted({ raw: "" }, "empty");
  nothingPosted({ raw: '{"notes":[{"agent":"planner","text":"a"}]}\n{"notes":[{"agent":"coder","text":"b"}]}' }, "two documents");
  nothingPosted({ raw: '[{"agent":"planner","text":"a"}]' }, "an array at the top");
  nothingPosted({ raw: '"planner"' }, "a string at the top");
  nothingPosted({ raw: "null" }, "null");
  nothingPosted({ raw: '{"notes":"planner"}' }, "notes is not an array");
  nothingPosted({ raw: '{"notes":{"agent":"planner","text":"a"}}' }, "notes is an object");
  // a symlink (to something that would otherwise parse) is not followed
  nothingPosted({ setup: (file, w) => { writeFileSync(join(w.root, "real.json"), JSON.stringify({ notes: FOUR })); symlinkSync(join(w.root, "real.json"), file); } }, "symlink");
  // exactly at the limit still works (8192 bytes)
  const pad = (n) => JSON.stringify({ notes: [note("planner", "ok")], verdict: null, pad: "x".repeat(n) });
  const base = Buffer.byteLength(pad(0));
  withRun({ raw: pad(8192 - base) }, (r) => assert.equal(r.posts.length, 1, "8192 bytes"));
  nothingPosted({ raw: pad(8193 - base) }, "8193 bytes");
});

test("notify-agents: needs_you is only ever the boolean true", () => {
  for (const v of ["true", "yes", 1, "1", ["true"], [true], { a: true }, null, "Needs you", 0, false]) {
    withRun({ notes: { notes: [note("planner", "plain", { needs_you: v })], verdict: null } }, (r) => {
      assert.equal(r.posts[0].text, "🧭 Planner: plain", JSON.stringify(v));
    });
  }
  withRun({ notes: { notes: [note("planner", "Needs you: pick one", { needs_you: true })], verdict: null } }, (r) => {
    assert.equal(r.posts[0].text, "🧭 Planner: <@U0ABC123> Needs you: pick one");
  });
  // the file's flag is what counts: text that says "Needs you:" with needs_you false is not a tag
  withRun({ notes: { notes: [note("planner", "Needs you: pick one", { needs_you: false })], verdict: null } }, (r) => {
    assert.equal(r.posts[0].text, "🧭 Planner: Needs you: pick one");
  });
});

// ---- notify-agents: tagging

test("notify-agents: the reviewer's note is tagged for REQUEST CHANGES and BLOCK, never for APPROVE or null, and no other note is", () => {
  for (const [verdict, tagged] of [["REQUEST CHANGES", true], ["BLOCK", true], ["APPROVE", false], [null, false]]) {
    withRun({ notes: { notes: FOUR, verdict } }, (r) => {
      const texts = r.posts.map((p) => p.text);
      assert.equal(texts[3], tagged ? "🔍 Reviewer: <@U0ABC123> Reviewed." : "🔍 Reviewer: Reviewed.", String(verdict));
      assert.deepEqual(texts.slice(0, 3), ["🧭 Planner: Planned.", "🔨 Coder: Built.", "🧪 Tester: Tested."]);
    });
  }
  // a needs_you reviewer note with a blocking verdict is tagged once, not twice
  withRun({ notes: { notes: [note("reviewer", "Needs you: decide", { needs_you: true })], verdict: "BLOCK" } }, (r) => {
    assert.equal(r.posts[0].text, "🔍 Reviewer: <@U0ABC123> Needs you: decide");
  });
});

test("notify-agents: the tag target must be a Slack user id; anything else posts without a tag", () => {
  const needs = { notes: [note("planner", "Needs you: x", { needs_you: true })], verdict: null };
  for (const user of ["U0ABC123", "W0ABC123", "UABC", "U12"]) {
    withRun({ notes: needs, env: { SLACK_USER: user } }, (r) => assert.equal(r.posts[0].text, `🧭 Planner: <@${user}> Needs you: x`, user));
  }
  for (const user of ["", "U1", "u0abc123", "C0ABC123", "U0ABC123\n<!channel>", "U0ABC123 <!channel>", "<!channel>", "<@U0ABC123>", "U0ABC123|x", "U0ABC123>", "U0ABC123\n", "@here", "U0 ABC", "$(id)", "`id`", "U0ABC123;id"]) {
    withRun({ notes: needs, env: { SLACK_USER: user } }, (r) => {
      assert.equal(r.posts.length, 1, `still posts: ${JSON.stringify(user)}`);
      assert.equal(r.posts[0].text, "🧭 Planner: Needs you: x", JSON.stringify(user));
      assert.ok(!r.posts[0].text.includes("<"), JSON.stringify(user));
      assert.equal(r.posts[0].unfurl_links, false);
    });
  }
});

test("notify-agents: an Actions-tab run (no user) posts its notes in the thread, with no tag", () => {
  withRun({ notes: { notes: [note("planner", "Needs you: x", { needs_you: true }), note("reviewer", "bad", { needs_you: false })], verdict: "BLOCK" }, env: { SLACK_USER: "" } }, (r) => {
    assert.deepEqual(r.posts.map((p) => p.text), ["🧭 Planner: Needs you: x", "🔍 Reviewer: bad"]);
    assert.ok(r.posts.every((p) => p.thread_ts === "1700000000.000100"));
  });
});

// ---- no agent text reaches a shell string or a curl argument

test("notify-agents: a note full of $(…), backticks and quotes is posted literally and executes nothing", () => {
  const nasty = [
    '$(touch PWNED1)', '`touch PWNED2`', 'say "hi" and \'bye\'', "back\\slash \\n \\\\ \\u0041", '"; touch PWNED3; echo "', "$HOME ${HOME} $((1+1)) !! $'x'",
    "line one\nline two\n$(touch PWNED4)", "tab\there", '"}\' -H "X-Evil: 1', "%s %d %n", "-d @/etc/passwd", "--output PWNED5",
  ];
  const texts = nasty.slice(0, 4).map((t, i) => note(["planner", "coder", "tester", "reviewer"][i], t));
  withRun({ notes: { notes: texts, verdict: null } }, (r) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.posts.length, 4);
    assert.equal(r.posts[0].text, "🧭 Planner: $(touch PWNED1)");
    assert.equal(r.posts[1].text, "🔨 Coder: `touch PWNED2`");
    assert.equal(r.posts[2].text, '🧪 Tester: say "hi" and \'bye\'');
    assert.equal(r.posts[3].text, "🔍 Reviewer: back\\slash \\n \\\\ \\u0041");
    assert.deepEqual(readdirSync(r.w.cwd), [], "something was executed");
    assertNoAgentTextInArgs(r, nasty);
  });
  const more = nasty.slice(4, 8).map((t, i) => note(["planner", "coder", "tester", "reviewer"][i], t));
  withRun({ notes: { notes: more, verdict: null } }, (r) => {
    assert.equal(r.posts[0].text, '🧭 Planner: "; touch PWNED3; echo "');
    assert.equal(r.posts[1].text, "🔨 Coder: $HOME ${HOME} $((1+1)) !! $'x'");
    assert.equal(r.posts[2].text, "🧪 Tester: line one\nline two\n$(touch PWNED4)");
    assert.equal(r.posts[3].text, "🔍 Reviewer: tab\there");
    assert.deepEqual(readdirSync(r.w.cwd), []);
    assertNoAgentTextInArgs(r, nasty);
  });
  const rest = nasty.slice(8).map((t, i) => note(["planner", "coder", "tester", "reviewer"][i], t));
  withRun({ notes: { notes: rest, verdict: null } }, (r) => {
    assert.equal(r.posts.length, 4);
    assert.equal(r.posts[3].text, "🔍 Reviewer: --output PWNED5");
    assert.deepEqual(readdirSync(r.w.cwd), []);
    assertNoAgentTextInArgs(r, nasty);
  });
});
function assertNoAgentTextInArgs(r, texts) {
  const argv = r.calls.flat().join("\n");
  for (const t of texts) {
    const needle = t.split("\n")[0].slice(0, 12);
    assert.ok(!argv.includes(needle) || needle.length < 3, `agent text ${JSON.stringify(t)} appears in a curl argument`);
  }
  // every call has exactly the same arguments: the notes only ever travel on stdin
  assert.equal(new Set(r.calls.map((c) => JSON.stringify(c))).size, 1);
}

test("notify-agents: a failing curl never fails the job", () => {
  withRun({ notes: { notes: FOUR, verdict: null }, curlExit: 7 }, (r) => {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.posts.length, 4, "it tried every post");
  });
});

// ---- notify-start: the thread's first message, and its ts

test("notify-start: the brief is escaped, previews are off, and the Slack ts becomes the thread_ts output", () => {
  const w = sandbox({ response: '{"ok":true,"channel":"C0CHAN","ts":"1700000000.000100"}' });
  try {
    const out = join(w.root, "gh_output");
    const r = run(w, START_STEP, { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C0CHAN", BRIEF: "fix <!channel> & https://x.example/a $(touch PWNED)", GITHUB_OUTPUT: out });
    assert.equal(r.status, 0, r.stderr);
    const [p, ...more] = postsOf(w.root);
    assert.equal(more.length, 0);
    assert.equal(p.text, "▶️ Design → build → test → review: fix &lt;!channel&gt; &amp; https://x.example/a $(touch PWNED)");
    assert.equal(p.unfurl_links, false);
    assert.equal(p.unfurl_media, false);
    assert.ok(!("thread_ts" in p), "the start message is the thread's root");
    assert.equal(readFileSync(out, "utf8"), "thread_ts=1700000000.000100\n");
    assert.deepEqual(readdirSync(w.cwd), []);
    assert.ok(!callsOf(w.root).flat().some((a) => a.includes("PWNED")));
  } finally { rmSync(w.root, RM); }
});

test("notify-start: no output when Slack refuses, answers with something odd, or the ts does not look like one", () => {
  for (const response of ['{"ok":false,"error":"channel_not_found"}', "", "<html>502</html>", '{"ok":true}', '{"ok":true,"ts":"1700000000.000100\\n<!channel>"}', '{"ok":true,"ts":"x; rm -rf /"}', '{"ok":true,"ts":1700000000.0001}', '{"ok":"true","ts":"1700000000.000100"}']) {
    const w = sandbox({ response });
    try {
      const out = join(w.root, "gh_output");
      const r = run(w, START_STEP, { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C1", BRIEF: "b", GITHUB_OUTPUT: out });
      assert.equal(r.status, 0, `${response}: ${r.stderr}`);
      assert.ok(!existsSync(out) || readFileSync(out, "utf8") === "", response);
    } finally { rmSync(w.root, RM); }
  }
  // a failing curl, or no GITHUB_OUTPUT at all, does not fail the job either
  const w = sandbox({ curlExit: 7, response: '{"ok":true,"ts":"1700000000.000100"}' });
  try {
    assert.equal(run(w, START_STEP, { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C1", BRIEF: "b" }).status, 0);
  } finally { rmSync(w.root, RM); }
  // nothing configured, nothing posted
  for (const env of [{ SLACK_BOT_TOKEN: "", SLACK_CHANNEL: "C1" }, { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "" }]) {
    const w2 = sandbox();
    try {
      assert.equal(run(w2, START_STEP, { BRIEF: "b", ...env }).status, 0);
      assert.equal(postsOf(w2.root).length, 0);
    } finally { rmSync(w2.root, RM); }
  }
});

// ---- notify-failure: thread, tag, previews

function failure(env) {
  const w = sandbox();
  try {
    const r = run(w, FAILURE_STEP, { RUN_URL: "https://github.com/x/y/actions/runs/7", GITHUB_RUN_ID: "7", GITHUB_REPOSITORY: "x/y", ACTOR: "someone", ...BASE_ENV, ...env });
    assert.equal(r.status, 0, r.stderr);
    return postsOf(w.root);
  } finally { rmSync(w.root, RM); }
}

test("notify-failure: replies in the run's thread, tags the person who started it, previews off", () => {
  for (const env of [{ PIPELINE_RESULT: "failure" }, { PIPELINE_RESULT: "success", PUBLISH_RESULT: "failure" }, { PIPELINE_RESULT: "cancelled" }, { PIPELINE_RESULT: "skipped" }, { PREPARE_RESULT: "failure", PIPELINE_RESULT: "skipped" }]) {
    const [p, ...more] = failure(env);
    assert.equal(more.length, 0);
    assert.match(p.text, /^<@U0ABC123> (❌|⏸️|⚠️) D3 Factory/, JSON.stringify(env));
    assert.equal(p.thread_ts, "1700000000.000100");
    assert.equal(p.channel, "C0CHAN");
    assert.equal(p.unfurl_links, false);
    assert.equal(p.unfurl_media, false);
  }
});

test("notify-failure: no thread_ts posts top-level; an invalid user id (or none) posts without a tag", () => {
  assert.ok(!("thread_ts" in failure({ PIPELINE_RESULT: "failure", THREAD_TS: "" })[0]));
  assert.ok(!("thread_ts" in failure({ PIPELINE_RESULT: "failure", THREAD_TS: "1;id" })[0]));
  for (const user of ["", "bad", "U0ABC123\n<!channel>", "<!channel>", "U1", "u0abc123"]) {
    const [p] = failure({ PIPELINE_RESULT: "failure", SLACK_USER: user });
    assert.equal(p.text, "❌ D3 Factory run failed in the agent job. See https://github.com/x/y/actions/runs/7", JSON.stringify(user));
    assert.equal(p.unfurl_links, false);
  }
});

test("notify-failure: an Actions-tab run posts to the default channel with no tag, and nowhere when none is set", () => {
  const [p] = failure({ PIPELINE_RESULT: "failure", SLACK_CHANNEL: "C0DEFAULT", SLACK_USER: "" });
  assert.equal(p.channel, "C0DEFAULT");
  assert.ok(!p.text.includes("<@"));
  assert.deepEqual(failure({ PIPELINE_RESULT: "failure", SLACK_CHANNEL: "", SLACK_USER: "" }), []);
});

// ---- workflow invariants

test("workflow: EVERY chat.postMessage carries unfurl_links:false and unfurl_media:false, and sends its payload on stdin", () => {
  const holders = ["notify-start", "notify-agents", "publish", "notify-failure"];
  for (const name of JOBS) {
    const text = codeOnly(job(name));
    const posts = text.split("chat.postMessage").length - 1;
    if (!holders.includes(name)) { assert.equal(posts, 0, `${name} posts to Slack`); continue; }
    assert.ok(posts >= 1, `${name} has no Slack post`);
    assert.equal(text.split(/unfurl_links:\s*false/).length - 1, posts, `${name}: every post needs unfurl_links:false`);
    assert.equal(text.split(/unfurl_media:\s*false/).length - 1, posts, `${name}: every post needs unfurl_media:false`);
    assert.doesNotMatch(text, /unfurl_(links|media):\s*true/);
    // the flag belongs to the payload the post sends: it is built in the same statement
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      if (!l.includes("chat.postMessage")) return;
      const stmt = lines.slice(Math.max(0, i - 8), i + 6).join("\n");
      assert.match(stmt, /unfurl_links:\s*false/, `${name}: no unfurl_links near the post at line ${i}`);
      assert.match(stmt, /unfurl_media:\s*false/, `${name}: no unfurl_media near the post at line ${i}`);
      // no curl argument is ever built from a payload or a message: the only body flag on a Slack post is --data @-
      const curl = lines.slice(i - 1, i + 4).join("\n");
      assert.match(curl, /--data @-/, `${name}: a Slack post must send its payload with --data @-`);
      assert.doesNotMatch(curl.replace("--data @-", ""), /\s-d\s|--data|--json|--form|-F\s/, `${name}: another body flag on a Slack post`);
    });
  }
  assert.equal(WORKFLOW.split("chat.postMessage").length - 1 >= 4, true);
});

test("workflow: every Slack channel is the payload's, falling back to the D3_DEFAULT_CHANNEL variable", () => {
  for (const name of ["notify-start", "notify-agents", "publish", "notify-failure"]) {
    assert.match(job(name), /SLACK_CHANNEL: \$\{\{ github\.event\.client_payload\.channel \|\| vars\.D3_DEFAULT_CHANNEL \}\}/, name);
  }
  assert.equal(WORKFLOW.split("D3_DEFAULT_CHANNEL").length - 1 >= 4, true);
  // the tag comes from the payload's user only (an Actions-tab run has none), never from github.actor
  for (const name of ["notify-agents", "publish", "notify-failure"]) {
    assert.match(job(name), /SLACK_USER: \$\{\{ github\.event\.client_payload\.user \}\}/, name);
    assert.doesNotMatch(codeOnly(job(name)).replace(/ACTOR: .*/g, ""), /SLACK_USER: .*github\.actor/, name);
  }
  // the Slack user id is checked against ^[UW][A-Z0-9]{2,}$ before a tag is built, in every poster
  for (const name of ["notify-agents", "publish", "notify-failure"]) {
    assert.match(job(name), /\[\[ "\$SLACK_USER" =~ \^\[UW\]\[A-Z0-9\]\{2,\}\$ \]\]/, name);
  }
});

test("workflow: every poster threads on the start message's ts, which notify-start exposes", () => {
  assert.match(job("notify-start"), /outputs:\n(\s+#.*\n)*\s+thread_ts: \$\{\{ steps\.start\.outputs\.thread_ts \}\}/);
  assert.match(job("notify-start"), /- name: Tell Slack the run started\n\s+id: start/);
  for (const name of ["notify-agents", "publish", "notify-failure"]) {
    assert.match(job(name), /THREAD_TS: \$\{\{ needs\.notify-start\.outputs\.thread_ts \}\}/, name);
    assert.match(job(name), /needs: \[[^\]]*notify-start[^\]]*\]/, name);
  }
});

const jobIf = (name) => {
  const m = job(name).match(/\n    if: \$\{\{ (.+) \}\}\n/);
  assert.ok(m, `${name} has no if`);
  return m[1];
};
const evalIf = (expr, results, { cancelled = false } = {}) =>
  new Function("needs", "always", "cancelled", `return (${expr});`)(
    Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { result: v }])), () => true, () => cancelled);
const R = ["success", "failure", "skipped", "cancelled"];

test("workflow: publish needs notify-agents but runs whenever the pipeline succeeded, even if Slack jobs failed or were skipped", () => {
  assert.match(job("publish"), /needs: \[prepare, pipeline, notify-start, notify-agents\]/);
  const expr = jobIf("publish");
  assert.match(expr, /!cancelled\(\)/);
  assert.doesNotMatch(expr, /always\(\)/, "always() would also run publish after a cancel");
  assert.doesNotMatch(expr, /notify-/, "publish must not depend on how a Slack job went");
  assert.equal(evalIf(expr, { prepare: "success", pipeline: "success" }), true);
  for (const agents of R) for (const start of R) {
    assert.equal(evalIf(expr, { prepare: "success", pipeline: "success", "notify-agents": agents, "notify-start": start }), true, `notify-agents ${agents}, notify-start ${start}`);
  }
  // a cancelled run does not publish, and neither does a run whose pipeline did not succeed
  assert.equal(evalIf(expr, { prepare: "success", pipeline: "success" }, { cancelled: true }), false);
  for (const pipeline of ["failure", "skipped", "cancelled"]) assert.equal(evalIf(expr, { prepare: "success", pipeline }), false, pipeline);
  for (const prepare of ["failure", "skipped", "cancelled"]) assert.equal(evalIf(expr, { prepare, pipeline: "success" }), false, prepare);
});

test("workflow: notify-failure never fires because a Slack job failed, only for prepare, pipeline or publish", () => {
  const expr = jobIf("notify-failure");
  assert.match(job("notify-failure"), /needs: \[prepare, pipeline, publish, notify-start\]/);
  assert.match(expr, /^always\(\) && /);
  assert.doesNotMatch(expr, /notify-/, "the condition must not mention the Slack jobs");
  assert.deepEqual([...new Set([...expr.matchAll(/needs\.([a-z-]+)\.result/g)].map((m) => m[1]))].sort(), ["pipeline", "prepare", "publish"]);
  const ok = { prepare: "success", pipeline: "success", publish: "success" };
  // a Slack outage, in any shape, with everything else green: silence
  for (const agents of R) for (const start of R) {
    assert.equal(evalIf(expr, { ...ok, "notify-agents": agents, "notify-start": start }), false, `notify-agents ${agents}, notify-start ${start}`);
  }
  // the real failures still fire it, whatever the Slack jobs did
  for (const [name, results] of [["prepare failed", { prepare: "failure", pipeline: "skipped", publish: "skipped" }], ["pipeline failed", { prepare: "success", pipeline: "failure", publish: "skipped" }],
    ["publish failed", { ...ok, publish: "failure" }], ["pipeline skipped (kill switch)", { prepare: "success", pipeline: "skipped", publish: "skipped" }],
    ["pipeline cancelled", { prepare: "success", pipeline: "cancelled", publish: "skipped" }], ["publish cancelled", { ...ok, publish: "cancelled" }]]) {
    for (const start of R) assert.equal(evalIf(expr, { ...results, "notify-start": start, "notify-agents": "failure" }), true, `${name}, notify-start ${start}`);
  }
  assert.match(job("notify-failure"), /permissions: \{\}/);
});

test("workflow: notify-agents runs after the pipeline (failed or not), never when it was skipped, and holds only the Slack token", () => {
  const text = job("notify-agents");
  assert.match(text, /needs: \[pipeline, notify-start\]/);
  const expr = jobIf("notify-agents");
  assert.match(expr, /always\(\)/);
  for (const pipeline of ["success", "failure", "cancelled"]) assert.equal(evalIf(expr, { pipeline, "notify-start": "failure" }), true, pipeline);
  assert.equal(evalIf(expr, { pipeline: "skipped", "notify-start": "skipped" }), false);
  assert.deepEqual([...new Set([...codeOnly(text).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))], ["SLACK_BOT_TOKEN"]);
  assert.match(text, /permissions: \{\}/);
  assert.doesNotMatch(codeOnly(text), /actions\/checkout|GITHUB_TOKEN|d3-orchestrator|\bnode\b|\bnpm\b|docker/);
  // a missing artifact (nothing to download) must not fail the job
  assert.match(text, /download-artifact@v4\n\s+continue-on-error: true\n\s+with:\n\s+name: factory-notes/);
});

test("workflow: the pipeline job keeps the notes of a failed run: collected and uploaded with if: always()", () => {
  const text = job("pipeline");
  assert.match(text, /- name: Collect the agents' notes \(a regular file of at most 8 KB, or nothing\)\n\s+if: always\(\)/);
  assert.match(text, /- uses: actions\/upload-artifact@v4\n\s+if: always\(\)\n\s+with:\n\s+name: factory-notes\n\s+path: \$\{\{ runner\.temp \}\}\/notes-up\/factory-notes\.json\n\s+if-no-files-found: ignore/);
  // the notes directory is its own mount, outside the agents' repo copy
  assert.match(text, /-v "\$RUNNER_TEMP\/d3-notes:\/notes"/);
  assert.doesNotMatch(text, /d3-agent-repo\/(notes|factory-notes)|d3-agent-repo:\/notes/);
  // collected after the agents and before the commit step, so a commit failure cannot lose them
  assert.ok(text.indexOf("Collect the agents' notes") > text.indexOf("Run pipeline in the agent container"));
  assert.ok(text.indexOf("Collect the agents' notes") < text.indexOf("Commit and bundle the agents' work"));
});

test("pipeline collect step: takes only a regular file of at most 8 KB, never through a link", () => {
  const step = "Collect the agents' notes (a regular file of at most 8 KB, or nothing)";
  const cases = {
    ok: (dir) => writeFileSync(join(dir, "factory-notes.json"), '{"notes":[]}'),
    big: (dir) => writeFileSync(join(dir, "factory-notes.json"), "x".repeat(8193)),
    exact: (dir) => writeFileSync(join(dir, "factory-notes.json"), "x".repeat(8192)),
    link: (dir, w) => { writeFileSync(join(w.root, "elsewhere"), "{}"); symlinkSync(join(w.root, "elsewhere"), join(dir, "factory-notes.json")); },
    dir: (dir) => mkdirSync(join(dir, "factory-notes.json")),
    none: () => {},
  };
  for (const [name, make] of Object.entries(cases)) {
    const w = sandbox();
    try {
      const dir = join(w.root, "d3-notes");
      mkdirSync(dir);
      make(dir, w);
      const r = run(w, step, { RUNNER_TEMP: w.root });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      const up = join(w.root, "notes-up", "factory-notes.json");
      assert.equal(existsSync(up), ["ok", "exact"].includes(name), name);
      if (existsSync(up)) assert.ok(!readFileSync(up, "utf8").includes("elsewhere"));
    } finally { rmSync(w.root, RM); }
  }
});

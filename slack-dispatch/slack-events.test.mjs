// Tests for the Slack Events API handler (slack-dispatch/api/slack-events.js) — the emoji
// (reaction_added) path that fires an on-demand PR review and replies in the same thread.
// Run: node --test slack-dispatch/*.test.mjs (the factory scripts CI job runs them).
// Kept outside api/ on purpose: Vercel turns every file in api/ into a function.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import handler, { readRaw } from "./api/slack-events.js";

const SECRET = "test-signing-secret";
const ALLOWED = "U012ABC";
const CHANNEL = "C0FACTORY";
const ITEM_TS = "1700000000.000200";
const ENV_KEYS = ["SLACK_SIGNING_SECRET", "D3_ALLOWED_USERS", "GH_DISPATCH_PAT", "SLACK_BOT_TOKEN", "D3_REVIEW_EMOJI"];

let savedEnv;
let savedFetch;
let fetchCalls;
let reactionMessage; // what reactions.get returns as .message

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.D3_ALLOWED_USERS = `${ALLOWED}, U034DEF`;
  process.env.GH_DISPATCH_PAT = "github_pat_test";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  delete process.env.D3_REVIEW_EMOJI; // default emoji "d3-review"
  fetchCalls = [];
  reactionMessage = { type: "message", text: "see https://github.com/Phoresight-io/clyintel-app/pull/42", ts: ITEM_TS };
  stubFetch(routedFetch);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch;
});

function stubFetch(impl) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return impl(url, init);
  };
}

// Routes the three outbound calls this handler can make: reactions.get, the GitHub dispatch, chat.postMessage.
function routedFetch(url) {
  if (url.includes("/reactions.get")) return new Response(JSON.stringify({ ok: true, message: reactionMessage }), { status: 200 });
  if (url.includes("/chat.postMessage")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
  return new Response(null, { status: 204 }); // dispatches
}

const dispatchCalls = () => fetchCalls.filter((c) => c.url.includes("/dispatches"));
const postCalls = () => fetchCalls.filter((c) => c.url.includes("/chat.postMessage"));

const now = () => String(Math.floor(Date.now() / 1000));
const sign = (ts, body, secret = SECRET) =>
  "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

const reactionEvent = ({ user = ALLOWED, reaction = "d3-review", item } = {}) =>
  JSON.stringify({
    type: "event_callback",
    event: {
      type: "reaction_added",
      user,
      reaction,
      item: item ?? { type: "message", channel: CHANNEL, ts: ITEM_TS },
    },
  });

function makeReq({ body = reactionEvent(), method = "POST", ts = now(), signature, headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.headers = {
    "content-type": "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signature ?? sign(ts, body),
    ...headers,
  };
  return req;
}

function makeRes() {
  const res = { statusCode: 200, body: undefined, ended: false };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => ((res.body = obj), (res.ended = true), res);
  res.send = (text) => ((res.body = text), (res.ended = true), res);
  res.end = () => ((res.ended = true), res);
  return res;
}

async function call(reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

test("non-POST is refused with 405", async () => {
  const res = await call({ method: "GET" });
  assert.equal(res.statusCode, 405);
  assert.equal(fetchCalls.length, 0);
});

test("a bad signature gets 401 and starts nothing", async () => {
  const res = await call({ signature: sign(now(), reactionEvent(), "wrong-secret") });
  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);
});

test("an unset signing secret fails closed with 401", async () => {
  delete process.env.SLACK_SIGNING_SECRET;
  const res = await call();
  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);
});

test("url_verification echoes the challenge (only after the signature passes)", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "abc123xyz" });
  const res = await call({ body, signature: sign(now(), body) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { challenge: "abc123xyz" });
  assert.equal(fetchCalls.length, 0);
});

test("a url_verification with a bad signature is refused, not echoed", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "abc123xyz" });
  const res = await call({ body, signature: sign(now(), body, "wrong-secret") });
  assert.equal(res.statusCode, 401);
});

test("malformed JSON gets 400", async () => {
  const body = "{ not json";
  const res = await call({ body, signature: sign(now(), body) });
  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalls.length, 0);
});

test("a Slack retry is acknowledged without firing a second review", async () => {
  const res = await call({ headers: { "x-slack-retry-num": "1" } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.ended);
  assert.equal(dispatchCalls().length, 0);
});

test("a non-event_callback payload is a 200 no-op", async () => {
  const body = JSON.stringify({ type: "something_else" });
  const res = await call({ body, signature: sign(now(), body) });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 0);
});

test("the wrong emoji fires no review", async () => {
  const res = await call({ body: reactionEvent({ reaction: "thumbsup" }) });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 0);
});

test("a configured D3_REVIEW_EMOJI overrides the default", async () => {
  process.env.D3_REVIEW_EMOJI = "ship-it";
  const wrong = await call({ body: reactionEvent({ reaction: "d3-review" }) });
  assert.equal(wrong.statusCode, 200);
  assert.equal(fetchCalls.length, 0);

  const right = await call({ body: reactionEvent({ reaction: "ship-it" }) });
  assert.equal(right.statusCode, 200);
  assert.equal(dispatchCalls().length, 1);
});

test("a non-allowlisted user fires no review and does not reveal the gate", async () => {
  const res = await call({ body: reactionEvent({ user: "U999OTHER" }) });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 0);
});

test("a reaction on a non-message item is a 200 no-op", async () => {
  const res = await call({ body: reactionEvent({ item: { type: "file", file: "F1" } }) });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 0);
});

test("a message with a PR URL fires d3-review with the parsed pr, channel, thread_ts and user", async () => {
  const res = await call();
  assert.equal(res.statusCode, 200);

  const d = dispatchCalls();
  assert.equal(d.length, 1);
  const { url, init } = d[0];
  assert.equal(url, "https://api.github.com/repos/Phoresight-io/clyintel-app/dispatches");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer github_pat_test");
  assert.deepEqual(JSON.parse(init.body), {
    event_type: "d3-review",
    client_payload: { pr: "42", channel: CHANNEL, thread_ts: ITEM_TS, user: ALLOWED },
  });

  // Confirmation posted in the thread, previews off.
  const p = postCalls();
  assert.equal(p.length, 1);
  const post = JSON.parse(p[0].init.body);
  assert.equal(post.channel, CHANNEL);
  assert.equal(post.thread_ts, ITEM_TS);
  assert.equal(post.unfurl_links, false);
  assert.equal(post.unfurl_media, false);
  assert.match(post.text, /PR #42/);
});

test("the dispatch threads under the message's own thread_ts when the reacted message is a reply", async () => {
  const parentTs = "1699999999.000100";
  reactionMessage = { type: "message", text: "review #7 please", ts: ITEM_TS, thread_ts: parentTs };
  await call();
  const d = dispatchCalls();
  assert.equal(d.length, 1);
  assert.equal(JSON.parse(d[0].init.body).client_payload.thread_ts, parentTs);
});

test("a bare #<n> is used when there is no PR URL", async () => {
  reactionMessage = { type: "message", text: "can someone look at #108 today", ts: ITEM_TS };
  await call();
  const d = dispatchCalls();
  assert.equal(d.length, 1);
  assert.equal(JSON.parse(d[0].init.body).client_payload.pr, "108");
});

test("a message with no PR reference posts the couldn't-find note and fires no review", async () => {
  reactionMessage = { type: "message", text: "nothing actionable here", ts: ITEM_TS };
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(dispatchCalls().length, 0);

  const p = postCalls();
  assert.equal(p.length, 1);
  const post = JSON.parse(p[0].init.body);
  assert.match(post.text, /couldn't find a PR/i);
  assert.equal(post.thread_ts, ITEM_TS);
  assert.equal(post.unfurl_links, false);
});

test("a missing GH_DISPATCH_PAT posts a note and makes no GitHub call", async () => {
  delete process.env.GH_DISPATCH_PAT;
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(dispatchCalls().length, 0);
  assert.match(JSON.parse(postCalls()[0].init.body).text, /isn't fully configured/);
});

test("GitHub rejecting the dispatch posts an error note in the thread", async () => {
  stubFetch((url) => {
    if (url.includes("/reactions.get")) return new Response(JSON.stringify({ ok: true, message: reactionMessage }), { status: 200 });
    if (url.includes("/chat.postMessage")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response("Bad credentials", { status: 401 });
  });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.match(JSON.parse(postCalls()[0].init.body).text, /GitHub returned 401/);
});

test("a network failure reaching GitHub posts a note, not a success", async () => {
  stubFetch((url) => {
    if (url.includes("/reactions.get")) return new Response(JSON.stringify({ ok: true, message: reactionMessage }), { status: 200 });
    if (url.includes("/chat.postMessage")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    throw new TypeError("fetch failed");
  });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.match(JSON.parse(postCalls()[0].init.body).text, /Couldn't reach GitHub/);
});

test("reactions.get failing is a 200 no-op (no dispatch, no note)", async () => {
  stubFetch((url) => {
    if (url.includes("/reactions.get")) return new Response(JSON.stringify({ ok: false, error: "message_not_found" }), { status: 200 });
    return new Response(null, { status: 204 });
  });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(dispatchCalls().length, 0);
  assert.equal(postCalls().length, 0);
});

test("a body stream that never ends times out instead of hanging (400, no run)", async () => {
  const stalled = new PassThrough(); // emits nothing, never ends
  await assert.rejects(readRaw(stalled, 50), /timed out/);

  const req = new PassThrough();
  req.method = "POST";
  req.headers = {};
  req.write("{"); // a partial body, then silence
  const res = makeRes();
  const started = Date.now();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(Date.now() - started < 2500, "must answer inside Slack's 3-second window");
  assert.equal(fetchCalls.length, 0);
});

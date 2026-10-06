// Tests for the /d3 slash-command handler (slack-dispatch/api/slack-command.js).
// Run: node --test slack-dispatch/*.test.mjs (the factory scripts CI job runs them).
// Kept outside api/ on purpose: Vercel turns every file in api/ into a function.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import handler from "./api/slack-command.js";

const SECRET = "test-signing-secret";
const ALLOWED = "U012ABC";
const ENV_KEYS = ["SLACK_SIGNING_SECRET", "D3_ALLOWED_USERS", "GH_DISPATCH_PAT"];

let savedEnv;
let savedFetch;
let fetchCalls;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.D3_ALLOWED_USERS = `${ALLOWED}, U034DEF`;
  process.env.GH_DISPATCH_PAT = "github_pat_test";
  fetchCalls = [];
  stubFetch(() => new Response(null, { status: 204 }));
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

const now = () => String(Math.floor(Date.now() / 1000));
const sign = (ts, body, secret = SECRET) =>
  "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

const form = ({ text = "add invoice reminder", user = ALLOWED, channel = "C0FACTORY" } = {}) =>
  new URLSearchParams({ command: "/d3", text, user_id: user, channel_id: channel }).toString();

function makeReq({ body = form(), method = "POST", ts = now(), signature, headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.headers = {
    "content-type": "application/x-www-form-urlencoded",
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

test("a bad signature gets 401 and starts no run", async () => {
  const res = await call({ signature: sign(now(), form(), "wrong-secret") });
  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);
});

test("a correctly signed request older than 5 minutes gets 401 (replay guard)", async () => {
  const ts = String(Math.floor(Date.now() / 1000) - 301);
  const res = await call({ ts }); // signed with the stale timestamp
  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);
});

test("missing timestamp or a non-numeric one gets 401", async () => {
  for (const ts of ["", "12abc"]) {
    const res = await call({ ts });
    assert.equal(res.statusCode, 401, `ts=${JSON.stringify(ts)}`);
  }
  assert.equal(fetchCalls.length, 0);
});

test("an unset signing secret fails closed with 401", async () => {
  delete process.env.SLACK_SIGNING_SECRET;
  const res = await call();
  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);
});

test("an oversized body is refused with 413", async () => {
  const body = form({ text: "x".repeat(100_001) });
  const res = await call({ body });
  assert.equal(res.statusCode, 413);
  assert.equal(fetchCalls.length, 0);
});

test("a user not on the allow list is told they're not authorized, and no run starts", async () => {
  const res = await call({ body: form({ user: "U999OTHER" }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.response_type, "ephemeral");
  assert.match(res.body.text, /not authorized/i);
  assert.equal(fetchCalls.length, 0);
});

test("an empty allow list fails closed", async () => {
  process.env.D3_ALLOWED_USERS = " , ";
  const res = await call();
  assert.match(res.body.text, /not authorized/i);
  assert.equal(fetchCalls.length, 0);
});

test("an empty brief gets the usage message, and no run starts", async () => {
  const res = await call({ body: form({ text: "   " }) });
  assert.equal(res.body.response_type, "ephemeral");
  assert.match(res.body.text, /Usage/);
  assert.equal(fetchCalls.length, 0);
});

test("a brief over 4000 characters is refused; exactly 4000 is accepted", async () => {
  const tooLong = await call({ body: form({ text: "x".repeat(4001) }) });
  assert.match(tooLong.body.text, /too long/i);
  assert.equal(fetchCalls.length, 0);

  const atLimit = await call({ body: form({ text: "x".repeat(4000) }) });
  assert.match(atLimit.body.text, /starting/i);
  assert.equal(fetchCalls.length, 1);
});

test("a missing GH_DISPATCH_PAT says D3 isn't configured, and makes no GitHub call", async () => {
  delete process.env.GH_DISPATCH_PAT;
  const res = await call();
  assert.match(res.body.text, /isn't fully configured/);
  assert.equal(fetchCalls.length, 0);
});

test("GitHub returning 401 is reported with the status, not as a start", async () => {
  stubFetch(() => new Response("Bad credentials", { status: 401 }));
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.match(res.body.text, /GitHub returned 401/);
  assert.doesNotMatch(res.body.text, /starting/i);
});

test("a network failure reaching GitHub is reported, not swallowed", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const res = await call();
  assert.match(res.body.text, /Couldn't reach GitHub/);
});

test("a Slack retry is acknowledged without starting a second run", async () => {
  const res = await call({ headers: { "x-slack-retry-num": "1" } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.ended);
  assert.equal(fetchCalls.length, 0);
});

test("a successful dispatch sends d3-run with brief, channel and user, and the reply doesn't repeat the brief", async () => {
  const brief = "add a reminder for Acme invoice INV-1042";
  const res = await call({ body: form({ text: `  ${brief}  `, user: ALLOWED, channel: "C0FACTORY" }) });

  assert.equal(fetchCalls.length, 1);
  const { url, init } = fetchCalls[0];
  assert.equal(url, "https://api.github.com/repos/Phoresight-io/clyintel-app/dispatches");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer github_pat_test");
  assert.deepEqual(JSON.parse(init.body), {
    event_type: "d3-run",
    client_payload: { brief, channel: "C0FACTORY", user: ALLOWED },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.response_type, "ephemeral");
  assert.match(res.body.text, /starting/i);
  assert.ok(!res.body.text.includes(brief), "the reply must not echo the brief");
  assert.ok(!res.body.text.includes("INV-1042"));
});

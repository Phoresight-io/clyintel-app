import crypto from "node:crypto";

// Vercel serverless function (same Vercel project as slack-command.js, Root Directory slack-dispatch/).
// Receives Slack Events API POSTs, verifies them, and turns a `reaction_added` with the review emoji
// into an on-demand Claude PR review that posts back IN THE SAME SLACK THREAD. The verify/allowlist
// helpers are DUPLICATED from slack-command.js on purpose: keeping this handler self-contained keeps the
// blast radius minimal (duplication is an accepted pattern here). Usage: react to a message that names a
// PR (…/clyintel-app/pull/<n> or #<n>) with :d3-review:.
// Slack sends JSON; we need the RAW body to verify the signature, so bodyParser stays off.
export const config = { api: { bodyParser: false } };

// Event payloads are small; refuse anything big, and don't hang on a bad stream.
const MAX_BODY_BYTES = 100_000;
const READ_TIMEOUT_MS = 1500;
export const readRaw = (req, timeoutMs = READ_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    // Already read by someone else: the data/end events have fired and would never come again.
    if (req.readableEnded) return reject(new Error("body already consumed"));
    const chunks = [];
    let bytes = 0;
    let tooBig = false;
    const timer = setTimeout(() => {
      tooBig = true; // ignore anything that trickles in afterwards
      chunks.length = 0;
      reject(new Error("body read timed out")); // no destroy: the response still has to go out
    }, timeoutMs);
    req.on("data", (c) => {
      if (tooBig) return; // stop accumulating once rejected
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += buf.length; // bytes, not UTF-16 units
      if (bytes > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        clearTimeout(timer);
        reject(new Error("body too large"));
        req.destroy?.();
        return;
      }
      chunks.push(buf); // concat as bytes so a multi-byte char split across chunks survives
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

// Same HMAC logic as slack-command.js (duplicated to keep this handler self-contained).
function verifySlack(raw, headers) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false; // misconfigured: fail closed instead of throwing a 500
  const ts = headers["x-slack-request-timestamp"];
  const sig = headers["x-slack-signature"];
  if (!ts || !sig) return false;
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard (NaN-safe)
  const base = `v0:${ts}:${raw}`;
  const mine = "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
  const a = Buffer.from(mine);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// D3_ALLOWED_USERS = comma-separated Slack user IDs. Empty/unset means nobody (fail closed).
const allowedUsers = () =>
  (process.env.D3_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Slack Web API helpers. Both carry the bot token and the same 2.5s timeout as the GitHub call.
const slackPost = (method, body) =>
  fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2500),
  });

const slackGet = (method, params) => {
  const qs = new URLSearchParams(params).toString();
  return fetch(`https://slack.com/api/${method}?${qs}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(2500),
  });
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let raw;
  try {
    raw = await readRaw(req);
  } catch (err) {
    if (err.message !== "body too large") console.error("d3-events: could not read the request body:", err.message);
    return res.status(err.message === "body too large" ? 413 : 400).send("bad request body");
  }
  // Verify BEFORE answering anything, including the url_verification challenge.
  if (!verifySlack(raw, req.headers)) return res.status(401).send("bad signature");

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return res.status(400).send("bad request body");
  }

  // Events API setup handshake: echo the challenge (only after the signature passed).
  if (body.type === "url_verification") return res.status(200).json({ challenge: body.challenge });

  // Slack retries deliveries it thinks failed; the original attempt already fired the review, and a
  // second capped-key run must not follow. Ack the retry and do nothing (same rationale as the slash handler).
  if (req.headers["x-slack-retry-num"]) return res.status(200).end();

  if (body.type !== "event_callback") return res.status(200).end();

  const event = body.event || {};

  // Emoji gate: only the configured reaction triggers a review.
  const EMOJI = (process.env.D3_REVIEW_EMOJI || "d3-review").trim();
  if (event.type !== "reaction_added" || event.reaction !== EMOJI) return res.status(200).end();

  // Authorization (the per-run approval): only allowlisted users can start a run (a run executes
  // agents with shell + repo write access in CI). Don't reveal the gate — just a silent no-op.
  if (!event.user || !allowedUsers().includes(event.user)) {
    console.warn("d3-events: ignored reaction from non-allowlisted user", event.user);
    return res.status(200).end();
  }

  // Only reactions on messages carry something to review.
  const item = event.item || {};
  if (item.type !== "message" || !item.channel || !item.ts) return res.status(200).end();

  // Resolve the reacted message so we can read its text and find the thread to reply in.
  let message;
  try {
    const r = await slackGet("reactions.get", { channel: item.channel, timestamp: item.ts, full: "true" });
    const data = await r.json();
    if (!data.ok || !data.message) {
      console.error("d3-events: reactions.get did not return the message", data.error || r.status);
      return res.status(200).end();
    }
    message = data.message;
  } catch (err) {
    console.error("d3-events: could not reach Slack to resolve the message", err);
    return res.status(200).end();
  }

  const threadTs = message.thread_ts || item.ts; // reply in the message's thread, or start one on it
  const note = (text) =>
    slackPost("chat.postMessage", {
      channel: item.channel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    }).catch((err) => console.error("d3-events: Slack note failed", err));

  // Find the PR number in the message text: prefer a full repo PR URL, fall back to a bare #<n>.
  const text = message.text || "";
  const m = text.match(/clyintel-app\/pull\/(\d+)/i) || text.match(/#(\d+)/);
  if (!m) {
    await note("Couldn't find a PR link (…/clyintel-app/pull/<n> or #<n>) in that message, so there's nothing to review.");
    return res.status(200).end();
  }
  const pr = m[1];

  if (!process.env.GH_DISPATCH_PAT) {
    console.error("d3-events: GH_DISPATCH_PAT is not set");
    await note("⚠️ D3 isn't fully configured (dispatch token missing). Ask an admin.");
    return res.status(200).end();
  }

  // Fire the review BEFORE Slack freezes the function. The thread_ts rides along so the workflow
  // can mirror the verdict back into this same thread.
  try {
    const r = await fetch("https://api.github.com/repos/Phoresight-io/clyintel-app/dispatches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GH_DISPATCH_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: "d3-review",
        client_payload: { pr, channel: item.channel, thread_ts: threadTs, user: event.user },
      }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) {
      console.error("d3-events: review dispatch rejected by GitHub", r.status);
      await note(`⚠️ Couldn't start the review (GitHub returned ${r.status}). Check the dispatch token.`);
      return res.status(200).end();
    }
  } catch (err) {
    console.error("d3-events: review dispatch failed", err);
    await note("⚠️ Couldn't reach GitHub to start the review. Try again.");
    return res.status(200).end();
  }

  await note(`🔍 Review starting for PR #${pr}…`);
  return res.status(200).end();
}

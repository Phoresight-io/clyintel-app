import crypto from "node:crypto";

// Vercel serverless function (its own Vercel project, Root Directory slack-dispatch/, so the
// dispatch token never sits in the customer app's runtime). Receives Slack slash-command POSTs, verifies them,
// checks the caller against an allowlist, fires a GitHub repository_dispatch, then
// tells Slack the result. Usage in Slack: `/d3 <what to build>`.
// Slack sends x-www-form-urlencoded; we need the RAW body to verify the signature.
export const config = { api: { bodyParser: false } };

// Slash-command bodies are tiny; refuse anything big, and don't hang on a bad stream.
const MAX_BODY_BYTES = 100_000;
// The brief ends up in the agent prompt, the run log and the PR body (GitHub rejects bodies over 65,536 chars).
const MAX_BRIEF_CHARS = 4000;
const readRaw = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return; // stop accumulating once rejected
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += buf.length; // bytes, not UTF-16 units
      if (bytes > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        reject(new Error("body too large"));
        req.destroy?.();
        return;
      }
      chunks.push(buf); // concat as bytes so a multi-byte char split across chunks survives
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

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

// D3_ALLOWED_USERS = comma-separated Slack user IDs (e.g. "U012ABC,U034DEF").
// Empty/unset means nobody is allowed (fail closed).
const allowedUsers = () =>
  (process.env.D3_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const ephemeral = (res, text) => res.status(200).json({ response_type: "ephemeral", text });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let raw;
  try {
    raw = await readRaw(req);
  } catch {
    return res.status(413).send("bad request body");
  }
  if (!verifySlack(raw, req.headers)) return res.status(401).send("bad signature");

  // Defensive: Slack documents retry headers for the Events API, not slash commands, so this
  // may never fire. If a retry ever arrives with it, the original attempt already started the
  // run, and a second paid run (or pushing another user's queued run out of the concurrency
  // group) must not follow.
  if (req.headers["x-slack-retry-num"]) return res.status(200).end();

  const params = new URLSearchParams(raw);
  const brief = (params.get("text") || "").trim(); // e.g. "add invoice reminder"
  const channel = params.get("channel_id");
  const user = params.get("user_id");

  // Authorization comes before anything else happens: only allowlisted users can
  // start a run (a run executes agents with shell + repo write access in CI).
  if (!user || !allowedUsers().includes(user)) {
    console.warn("d3: rejected /d3 from non-allowlisted user", user);
    return ephemeral(res, "⛔ You're not authorized to run /d3.");
  }
  if (!brief) return ephemeral(res, "Usage: `/d3 <what to build>`");
  if (brief.length > MAX_BRIEF_CHARS) return ephemeral(res, `Brief is too long (max ${MAX_BRIEF_CHARS} characters).`);

  if (!process.env.GH_DISPATCH_PAT) {
    console.error("d3: GH_DISPATCH_PAT is not set");
    return ephemeral(res, "⚠️ D3 isn't fully configured (dispatch token missing). Ask an admin.");
  }

  // Dispatch BEFORE responding: on Vercel the function can be frozen once the
  // response is sent, and a GitHub call normally fits well inside Slack's 3s window.
  try {
    const r = await fetch("https://api.github.com/repos/Phoresight-io/clyintel-app/dispatches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GH_DISPATCH_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: "d3-run",
        client_payload: { brief, channel, user },
      }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) {
      console.error("d3: dispatch rejected by GitHub", r.status);
      return ephemeral(res, `⚠️ Couldn't start the run (GitHub returned ${r.status}). Check the dispatch token.`);
    }
  } catch (err) {
    console.error("d3: dispatch failed", err);
    return ephemeral(res, "⚠️ Couldn't reach GitHub to start the run. Try again.");
  }

  // Ephemeral and without the brief: it may name customers or invoices. The factory workflow's
  // notify-start job posts the start message to the configured channel.
  return ephemeral(res, "🏭 D3 pipeline starting. Progress will be posted in the channel.");
}

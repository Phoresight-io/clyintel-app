import crypto from "node:crypto";

// Vercel serverless function. Receives Slack slash-command POSTs, verifies them,
// ACKs within Slack's 3-second window, then fires a GitHub repository_dispatch.
// Slack sends x-www-form-urlencoded; we need the RAW body to verify the signature.
export const config = { api: { bodyParser: false } };

const readRaw = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

function verifySlack(raw, headers) {
  const ts = headers["x-slack-request-timestamp"];
  const sig = headers["x-slack-signature"];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const base = `v0:${ts}:${raw}`;
  const mine =
    "v0=" +
    crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET).update(base).digest("hex");
  const a = Buffer.from(mine);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRaw(req);
  if (!verifySlack(raw, req.headers)) return res.status(401).send("bad signature");

  const params = new URLSearchParams(raw);
  const text = (params.get("text") || "").trim(); // e.g. "build add invoice reminder"
  const channel = params.get("channel_id");
  const user = params.get("user_id");

  const [stage, ...rest] = text.split(" ");
  const brief = rest.join(" ");
  const eventType = stage === "approve" ? "d3-deploy" : "d3-run";

  // ACK immediately — this is what Slack shows the user right away.
  res.status(200).json({
    response_type: "in_channel",
    text:
      eventType === "d3-deploy"
        ? `🚀 Deploy approved by <@${user}>. Shipping…`
        : `🏭 D3 pipeline starting: *${stage}* — ${brief || "(no brief)"}`,
  });

  // Fire the GitHub dispatch after acking.
  try {
    await fetch("https://api.github.com/repos/Phoresight-io/clyintel-app/dispatches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GH_DISPATCH_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: eventType,
        client_payload: { stage, brief, channel, user },
      }),
    });
  } catch (err) {
    console.error("dispatch failed", err);
  }
}

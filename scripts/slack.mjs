// Minimal Slack poster. Uses chat.postMessage with a bot token. The orchestrator
// calls postSlack() to stream progress/results into the channel that triggered
// the run. No-ops when there's no channel (e.g. issue- or manually-triggered).
// Escape Slack's control characters so text we did not write (the brief, the
// reviewer's output) cannot render <!channel> pings or <url|label> links.
const escapeSlack = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function postSlack(channel, text) {
  if (!channel) return;
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text: escapeSlack(text) }),
      signal: AbortSignal.timeout(10_000), // never let Slack hold the pipeline
    });
    const data = await r.json();
    if (!data.ok) console.error("slack post failed:", data.error);
  } catch (err) {
    console.error("slack post error:", err);
  }
}

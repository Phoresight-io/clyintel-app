// Minimal MailerSend transactional-email sender.
//
// No SDK — product rule forbids adding npm packages without approval, so this
// mirrors the inline `fetch` pattern already used in app/api/email-reply/route.ts,
// centralised here so other routes (e.g. the subscription webhook) can reuse it.
//
// Throws on misconfiguration or a non-2xx MailerSend response. Callers on a
// non-critical path (e.g. a webhook whose primary job is a DB reconcile) should
// wrap this in try/catch and log failures rather than failing the request.

export interface SendEmailParams {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const apiKey = process.env.MAILERSEND_API_KEY;
  if (!apiKey) {
    throw new Error("MAILERSEND_API_KEY is not set");
  }

  const body = {
    from: { email: "team@phoresight.io", name: "Clyintel" },
    to: [{ email: params.to, name: params.toName ?? params.to }],
    subject: params.subject,
    text: params.text,
    html: params.html ?? `<p>${params.text.replace(/\n/g, "<br>")}</p>`,
  };

  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MailerSend error: ${res.status} ${detail}`.trim());
  }
}

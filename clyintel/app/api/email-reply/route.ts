import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/supabase";

const SYSTEM_PROMPT = `You are a professional AI collections agent for Clyintel, recovering outstanding invoice payments on behalf of small businesses. Be firm but respectful. You may offer a discount of up to 20% as goodwill — never more. Always calculate and state the discounted amount explicitly (e.g. "20% off $15,200 brings your balance to $12,160"). If the client requests a human or is hostile, include that someone will be in contact. Tone: 1-14 days overdue = friendly. 15-30 days = firm. 31-60 days = serious. 60+ = final notice. Respond in plain conversational text only — no JSON, no markdown. If asked something you don't know (e.g. specific account history, previous payments, internal notes), say: "I don't have that detail in front of me right now — let me have someone from our team follow up with you on that specifically." Do not make up information.`;

const INVOICE_CONTEXT: Record<number, string> = {
  1: `Invoice #: INV-2024-0891
Amount: $2,400.00
Due date: May 10, 2026
Days past due: 7
Client: Meridian Supply Co.
Contact: Charles W.
Business collecting: Hartwell Consulting Group
Payment link: https://pay.clyintel.com/demo
Discounted amount (20% off): $1,920.00`,

  2: `Invoice #: INV-2024-0744
Amount: $8,750.00
Due date: April 3, 2026
Days past due: 45
Client: Meridian Supply Co.
Contact: Charles W.
Business collecting: Hartwell Consulting Group
Payment link: https://pay.clyintel.com/demo
Discounted amount (20% off): $7,000.00`,

  3: `Invoice #: INV-2024-0612
Amount: $15,200.00
Due date: February 17, 2026
Days past due: 90
Client: Meridian Supply Co.
Contact: Charles W.
Business collecting: Hartwell Consulting Group
Payment link: https://pay.clyintel.com/demo
Discounted amount (20% off): $12,160.00`,
};

async function getSessionForSender(senderEmail: string): Promise<{ scenario: number; name: string }> {
  try {
    const { data } = await (getSupabase() as any)
      .from("demo_sessions")
      .select("scenario, name")
      .eq("email", senderEmail)
      .order("created_at", { ascending: false })
      .limit(1);
    return { scenario: data?.[0]?.scenario ?? 3, name: data?.[0]?.name ?? '' };
  } catch {
    return { scenario: 3, name: '' };
  }
}

async function processEmailReply(payload: unknown) {
  try {
    const data = (payload as any)?.data ?? payload;
    const senderEmail: string = data?.sender?.email ?? "";
    const senderName: string = data?.sender?.name ?? "";
    const emailText: string = data?.text ?? "";
    const subject: string = data?.subject ?? "";
    const inReplyTo: string = data?.message?.id ?? data?.in_reply_to ?? "";

    if (!senderEmail || !emailText) return;

    const supabase = getSupabase();
    const { scenario } = await getSessionForSender(senderEmail);
    const invoiceContext = INVOICE_CONTEXT[scenario] ?? INVOICE_CONTEXT[3];
    const systemPrompt = `${SYSTEM_PROMPT}\n\nInvoice context for this conversation:\n${invoiceContext}`;

    await (supabase as any).from('communications').insert({
      channel: 'email',
      direction: 'inbound',
      subject,
      body: emailText,
      from_address: senderEmail,
      to_address: 'team@phoresight.io',
      status: 'received',
      ai_interpreted: true,
      sent_at: new Date().toISOString(),
      airtable_subscriber_id: 'demo',
    });

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: emailText }],
      }),
    });

    if (!anthropicRes.ok) throw new Error(`Anthropic error: ${anthropicRes.status}`);

    const anthropicData = await anthropicRes.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const aiReply = anthropicData.content[0]?.text ?? "";

    const mailerPayload: Record<string, unknown> = {
      from: { email: "team@phoresight.io", name: "Clyintel Collections" },
      reply_to: { email: "ydfcveq0xfihgfgz5r4q@inbound.mailersend.net", name: "Clyintel Collections" },
      to: [{ email: senderEmail, name: senderName }],
      subject: `Re: ${subject}`,
      text: aiReply,
      html: `<p>${aiReply.replace(/\n/g, "<br>")}</p>`,
    };

    if (inReplyTo) {
      mailerPayload.headers = [
        { name: "In-Reply-To", value: inReplyTo },
        { name: "References", value: inReplyTo },
      ];
    }

    const mailerRes = await fetch("https://api.mailersend.com/v1/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MAILERSEND_API_KEY!}`,
      },
      body: JSON.stringify(mailerPayload),
    });

    if (!mailerRes.ok) throw new Error(`MailerSend error: ${mailerRes.status}`);

    await (supabase as any).from('communications').insert({
      channel: 'email',
      direction: 'outbound',
      subject: `Re: ${subject}`,
      body: aiReply,
      from_address: 'team@phoresight.io',
      to_address: senderEmail,
      status: 'sent',
      ai_response_sent: true,
      sent_at: new Date().toISOString(),
      airtable_subscriber_id: 'demo',
    });

    console.log("[email-reply] reply sent to", senderEmail, "scenario", scenario);
  } catch (err) {
    console.error("[email-reply] error:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
  }
}

export async function POST(req: NextRequest) {
  const payload = await req.json();
  waitUntil(processEmailReply(payload));
  return NextResponse.json({ ok: true }, { status: 200 });
}

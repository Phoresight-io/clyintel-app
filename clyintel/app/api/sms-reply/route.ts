import { NextRequest, NextResponse } from "next/server";
import { getSupabase, DemoSession, ConversationEntry } from "@/lib/supabase";

const INVOICE_CONTEXT: Record<number, { number: string; amount: string; days: number }> = {
  1: { number: 'INV-2024-0891', amount: '$2,400.00', days: 7 },
  2: { number: 'INV-2024-0744', amount: '$8,750.00', days: 45 },
  3: { number: 'INV-2024-0612', amount: '$15,200.00', days: 90 },
};

const SCENARIO_SUFFIX: Record<number, string> = {
  1: "Invoice is 7 days past due. Tone: warm and helpful. Offer the payment link if they ask. CRITICAL: reply MUST be 155 characters or fewer.",
  2: "Invoice is 45 days past due. Tone: direct and urgent. Payment plan available. CRITICAL: reply MUST be 155 characters or fewer.",
  3: "Invoice is 90 days past due. Tone: serious, final notice. Escalation to collections next. CRITICAL: reply MUST be 155 characters or fewer.",
};

function twiml(message: string): NextResponse {
  return new NextResponse(`<Response><Message>${message}</Message></Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const from = formData.get("From") as string;
    const body = formData.get("Body") as string;

    const supabase = getSupabase();

    const { data: sessions, error: queryError } = await (supabase as any)
      .from("demo_sessions")
      .select("*")
      .eq("phone", from)
      .order("created_at", { ascending: false })
      .limit(1);

    if (queryError) throw queryError;

    if (!sessions || sessions.length === 0) {
      return twiml("No active demo session found. Visit the demo page to start one.");
    }

    const session = sessions[0] as DemoSession;
    const invoice = INVOICE_CONTEXT[session.scenario] ?? INVOICE_CONTEXT[3];

    await (supabase as any).from('communications').insert({
      channel: 'sms',
      direction: 'inbound',
      body,
      from_address: from,
      to_address: 'twilio',
      status: 'received',
      ai_interpreted: true,
      sent_at: new Date().toISOString(),
      airtable_subscriber_id: 'demo',
    });

    const newClientEntry: ConversationEntry = {
      role: "client",
      message: body,
      timestamp: new Date().toISOString(),
    };

    const updatedHistory: ConversationEntry[] = [
      ...session.conversation_history,
      newClientEntry,
    ];

    const messages = updatedHistory.map((entry) => ({
      role: entry.role === "client" ? "user" : "assistant",
      content: entry.message,
    }));

    const basePrompt = `You are an AI collections agent for Clyintel. You are texting ${session.name} from Meridian Supply Co. about invoice ${invoice.number} for ${invoice.amount}, which is ${invoice.days} days past due. Payment link: https://pay.clyintel.com/demo. Keep all replies under 160 characters. Be conversational — this is SMS. Never break character. Do not explain that you are an AI.`;
    const systemPrompt = `${basePrompt} ${SCENARIO_SUFFIX[session.scenario]}`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 150,
        system: systemPrompt,
        messages,
      }),
    });

    if (!anthropicRes.ok) throw new Error(`Anthropic error: ${anthropicRes.status}`);

    const anthropicData = await anthropicRes.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const aiReply = (anthropicData.content[0]?.text ?? "").slice(0, 155);

    const newAgentEntry: ConversationEntry = {
      role: "agent",
      message: aiReply,
      timestamp: new Date().toISOString(),
    };

    const finalHistory: ConversationEntry[] = [...updatedHistory, newAgentEntry];

    await (supabase as any)
      .from("demo_sessions")
      .update({
        conversation_history: finalHistory,
        last_reply_at: new Date().toISOString(),
      } as any)
      .eq("id", session.id);

    await (supabase as any).from('communications').insert({
      channel: 'sms',
      direction: 'outbound',
      body: aiReply,
      from_address: 'twilio',
      to_address: from,
      status: 'sent',
      ai_response_sent: true,
      sent_at: new Date().toISOString(),
      airtable_subscriber_id: 'demo',
    });

    return twiml(aiReply);
  } catch (err) {
    console.error("[sms-reply]", err);
    return twiml("Something went wrong. Please try again.");
  }
}

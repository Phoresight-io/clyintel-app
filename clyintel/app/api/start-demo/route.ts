import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

const INVOICE_MAP: Record<number, { number: string; amount: string; amountCents: number }> = {
  1: { number: 'INV-2024-0891', amount: '$2,400.00', amountCents: 240000 },
  2: { number: 'INV-2024-0744', amount: '$8,750.00', amountCents: 875000 },
  3: { number: 'INV-2024-0612', amount: '$15,200.00', amountCents: 1520000 },
};

const COMPANY_NAME = 'Meridian Supply Co.';

export async function POST(req: NextRequest) {
  const body = await req.json();
  console.log('[start-demo] body:', JSON.stringify(body));

  const { firstName, lastName, phone } = body;
  let scenario = body.scenario;
  if (scenario === '7d') scenario = 1;
  else if (scenario === '45d') scenario = 2;
  else if (scenario === '90d') scenario = 3;

  if (!firstName || !lastName || !phone || scenario === undefined || scenario === null) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (![1, 2, 3].includes(Number(scenario))) {
    return NextResponse.json({ error: 'Invalid scenario' }, { status: 400 });
  }

  const name = `${firstName} ${lastName}`;
  const scenarioNum = Number(scenario);
  const invoice = INVOICE_MAP[scenarioNum];
  const supabase = getSupabase();

  const { error: insertError } = await supabase.from('demo_sessions').insert({
    name,
    company_name: COMPANY_NAME,
    phone,
    scenario: scenarioNum,
    conversation_history: [],
    invoice_number: invoice.number,
  });

  if (insertError) {
    console.log('[start-demo] supabase insert error:', insertError.message);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const vapiRes = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assistantId: process.env.VAPI_ASSISTANT_ID,
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: phone },
      assistantOverrides: {
        variableValues: {
          name,
          companyName: COMPANY_NAME,
          scenario: scenarioNum,
          invoiceNumber: invoice.number,
          invoiceAmount: invoice.amount,
        },
      },
    }),
  });

  if (!vapiRes.ok) {
    const errBody = await vapiRes.text();
    console.log('[start-demo] vapi error:', errBody);
    return NextResponse.json({ error: `Vapi error: ${vapiRes.status}` }, { status: 500 });
  }

  await (supabase as any).from('communications').insert({
    channel: 'voice',
    direction: 'outbound',
    subject: `Recovery call — ${invoice.number}`,
    body: `Outbound recovery call initiated for ${invoice.number} (${invoice.amount}) to ${name} at ${COMPANY_NAME}. Scenario: ${scenarioNum}.`,
    sent_at: new Date().toISOString(),
    status: 'sent',
    to_address: phone,
    from_address: 'vapi-agent',
    airtable_subscriber_id: 'demo',
  });

  console.log('[start-demo] success');
  return NextResponse.json({ success: true });
}

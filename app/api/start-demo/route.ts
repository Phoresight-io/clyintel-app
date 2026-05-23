import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { firstName, lastName, companyName, phone, scenario } = body;

  console.log('[start-demo] received request', { firstName, lastName, companyName, phone, scenario });

  if (!firstName || !lastName || !companyName || !phone || scenario === undefined || scenario === null) {
    console.log('[start-demo] validation failed: missing required fields');
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (![1, 2, 3].includes(Number(scenario))) {
    console.log('[start-demo] validation failed: invalid scenario', scenario);
    return NextResponse.json({ error: 'Invalid scenario' }, { status: 400 });
  }

  const name = `${firstName} ${lastName}`;
  const supabase = getSupabase();

  console.log('[start-demo] inserting demo_session', { name, companyName, phone, scenario });
  const { error: insertError } = await supabase.from('demo_sessions').insert({
    name,
    company_name: companyName,
    phone,
    scenario: Number(scenario),
    conversation_history: [],
  });

  if (insertError) {
    console.log('[start-demo] supabase insert error:', insertError.message);
    throw new Error(insertError.message);
  }
  console.log('[start-demo] demo_session inserted');

  console.log('[start-demo] calling vapi');
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
        variableValues: { name, companyName, scenario: Number(scenario) },
      },
    }),
  });
  console.log('[start-demo] vapi response status:', vapiRes.status);

  if (!vapiRes.ok) {
    const errBody = await vapiRes.text();
    console.log('[start-demo] vapi error body:', errBody);
    throw new Error(`Vapi error: ${vapiRes.status}`);
  }

  console.log('[start-demo] success');
  return NextResponse.json({ success: true });
}

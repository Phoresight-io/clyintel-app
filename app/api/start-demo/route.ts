import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { firstName, lastName, companyName, phone, scenario } = body;

  if (!firstName || !lastName || !companyName || !phone || scenario === undefined || scenario === null) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  if (![1, 2, 3].includes(Number(scenario))) {
    return NextResponse.json({ error: 'Invalid scenario' }, { status: 400 });
  }

  const name = `${firstName} ${lastName}`;
  const supabase = getSupabase();

  const { error: insertError } = await supabase.from('demo_sessions').insert({
    name,
    company_name: companyName,
    phone,
    scenario: Number(scenario),
    conversation_history: [],
  });

  if (insertError) throw new Error(insertError.message);

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

  if (!vapiRes.ok) throw new Error(`Vapi error: ${vapiRes.status}`);

  return NextResponse.json({ success: true });
}

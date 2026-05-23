import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/supabase';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, phone, companyName, scenario } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!phone || typeof phone !== 'string') {
    return NextResponse.json({ error: 'phone is required' }, { status: 400 });
  }
  if (scenario === undefined || scenario === null) {
    return NextResponse.json({ error: 'scenario is required' }, { status: 400 });
  }

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error: insertError } = await supabase
    .from('demo_sessions')
    .insert({
      name,
      phone,
      scenario: Number(scenario),
      company_name: companyName ?? null,
    });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const vapiRes = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assistantId: process.env.VAPI_ASSISTANT_ID,
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: phone },
      assistantOverrides: {
        variableValues: { name, companyName, scenario }
      }
    })
  });
  if (!vapiRes.ok) throw new Error(`Vapi error: ${vapiRes.status}`);

  return NextResponse.json({ ok: true });
}

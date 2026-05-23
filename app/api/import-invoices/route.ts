import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { fileName, rows } = body as { fileName: string; rows: Record<string, string>[] };

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No rows to import' }, { status: 400 });
  }

  const supabase = getSupabase();

  // The invoices table requires client_id and subscriber_id foreign keys, which
  // are not available in an unauthenticated import flow. We store the raw CSV
  // rows in demo_sessions.conversation_history (JSONB) as the import record.
  const { error } = await supabase.from('demo_sessions').insert({
    name: `CSV Import: ${fileName || 'upload.csv'}`,
    phone: '+10000000000',
    scenario: 1,
    conversation_history: rows,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, count: rows.length });
}

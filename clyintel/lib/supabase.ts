import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

export interface ConversationEntry {
  role: "client" | "agent";
  message: string;
  timestamp: string;
}

export interface DemoSession {
  id: string;
  name: string;
  company_name: string;
  phone: string;
  scenario: number;
  conversation_history: ConversationEntry[];
  invoice_number: string | null;
  last_reply_at: string | null;
  created_at: string;
}

// Server-side client (service-role key). Initialised per-request so that
// module evaluation during `next build` never throws when env vars are absent.
//
// Throws at construction if the service-role key is missing: a service-role
// client must NEVER silently degrade to the anon role, or privileged writes get
// rejected by RLS with no obvious cause (see the Connect onboarding bug). All
// call sites invoke this inside a request handler, so the throw surfaces a clear
// 500 at request time without breaking the build.
export function getSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — service-role client cannot be created"
    );
  }
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, key);
}

// Public (anon-key) client for client-side use. Also lazily initialised
// to keep the module safe to evaluate at build time.
export function getPublicSupabase() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

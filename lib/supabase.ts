import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

// Server-side client (service-role key). Initialised per-request so that
// module evaluation during `next build` never throws when env vars are absent.
export function getSupabase() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// Public (anon-key) client for client-side use. Also lazily initialised
// to keep the module safe to evaluate at build time.
export function getPublicSupabase() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

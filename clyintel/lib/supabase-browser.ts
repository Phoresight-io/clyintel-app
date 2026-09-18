import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/types/supabase';
import { publicEnv } from '@/lib/config/env.public';

export function createSupabaseBrowser() {
  return createBrowserClient<Database>(
    publicEnv.supabaseUrl(),
    publicEnv.supabaseAnonKey()
  );
}

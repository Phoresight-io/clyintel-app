import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/types/supabase';
import { ensureStripeCustomer } from '@/lib/stripe-customer';
import { publicEnv } from '@/lib/config/env.public';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient<Database>(
      publicEnv.supabaseUrl(),
      publicEnv.supabaseAnonKey(),
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // First authenticated session (Google sign-in or confirmed email link):
      // attach a Stripe customer so billing events can match this subscriber.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await ensureStripeCustomer(user.id).catch((e) =>
          console.error('auth/callback: ensureStripeCustomer failed', e)
        );
      }
      return NextResponse.redirect(`${origin}/`);
    }
  }

  return NextResponse.redirect(`${origin}/login`);
}

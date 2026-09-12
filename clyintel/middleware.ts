import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PUBLIC_PATHS = ['/login', '/auth/callback'];

// Inbound webhooks / external callbacks. These are invoked by external services
// (Vapi, Stripe, Intuit/QBO, MailerSend, Twilio) that never carry a session
// cookie, and each route verifies its own signature/secret. They MUST bypass the
// session-auth redirect entirely — otherwise the app's /login page swallows the
// request (returning 200) and the handler never runs.
//
// Deliberately NOT included: /api/voice/call — it has no self-authentication and
// triggers outbound calls, so it stays behind session auth (app-internal only).
const WEBHOOK_PATHS = [
  '/api/voice/webhook',
  '/api/stripe-webhook',
  '/api/qbo/webhook',
  '/api/webhooks/mailersend',
  '/api/sms-reply',
  '/api/email-reply',
];

export async function middleware(request: NextRequest) {
  // Early bypass: webhooks self-authenticate and have no session, so skip the
  // entire session-auth flow (no getUser, no /login redirect).
  const { pathname: webhookPathname } = request.nextUrl;
  if (WEBHOOK_PATHS.some((p) => webhookPathname === p || webhookPathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session — must be called on every request
  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  const isPublic = PUBLIC_PATHS.some(p =>
    pathname === p || pathname.startsWith(p + '/')
  );

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  // Forward the identity THIS getUser() resolved to Server Components (the root
  // layout seeds the account menu from it). Middleware is the single place that
  // refreshes/persists the session; a Server Component running its OWN getUser()
  // would race on the single-use refresh token (and can't persist a rotated one),
  // which is why the layout's own getUser() returned null. Rebuild the forwarded
  // request with the header, preserving any auth cookies the refresh wrote.
  if (user?.email) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user-email', user.email);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};

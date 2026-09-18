// Public (client-safe) environment access — NEXT_PUBLIC_* ONLY.
//
// Every variable is referenced as a LITERAL `process.env.NEXT_PUBLIC_XXX` so
// Next.js inlines it at build time (Next only inlines literal, statically
// analyzable references — a dynamic `process.env[name]` is NOT inlined and would
// be `undefined` in the browser). Do NOT add a non-public var here: this module
// is safe to import from Client Components, and anything without the
// NEXT_PUBLIC_ prefix is either undefined client-side (a silent footgun) or a
// secret that must live in `env.server.ts` instead.
//
// Required getters throw a clear, var-NAMED error on FIRST USE (never at module
// top level — this module is evaluated in the client bundle, and a top-level
// throw would break the build). Optional getters return `string | undefined` and
// let the caller choose the fallback. Var NAMES and values are identical to the
// pre-refactor `process.env` reads — this is a safety refactor, not a behavior
// change.

function requirePublic(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error(`Missing required public environment variable: ${name}`);
  }
  return value;
}

export const publicEnv = {
  /** Supabase project URL (REQUIRED). */
  supabaseUrl: (): string =>
    requirePublic("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),

  /** Supabase anon / publishable key (REQUIRED). */
  supabaseAnonKey: (): string =>
    requirePublic("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),

  /** Public site origin, e.g. https://app.clyintel.com (OPTIONAL — falls back to
   *  VERCEL_URL / localhost at the call site). */
  siteUrl: (): string | undefined => process.env.NEXT_PUBLIC_SITE_URL || undefined,

  /** Google Picker API key for the Drive import flow (OPTIONAL). */
  googleApiKey: (): string | undefined => process.env.NEXT_PUBLIC_GOOGLE_API_KEY || undefined,

  /** Google OAuth client id for the Drive import flow (OPTIONAL). */
  googleClientId: (): string | undefined => process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || undefined,
} as const;

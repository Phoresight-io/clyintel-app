import "server-only";

// Server-only environment access — secrets and server-system variables.
//
// This module centralizes every read of a server-side env var so the env
// contract is explicit (both Vercel projects must carry the same var NAMES) and
// a missing/misscoped var fails LOUD. Required getters throw a clear, var-NAMED
// error on FIRST USE; optional getters return `string | undefined` and let the
// caller keep its own fail-closed guard (the shape most webhook/cron routes
// already use, so their exact 401/500 responses are preserved).
//
// CLIENT-LEAK BOUNDARY: the `import "server-only"` above makes importing this
// module from a Client Component a BUILD error, so these secrets can never reach
// the browser bundle. env-config.test.ts additionally asserts (statically) that
// no "use client" file imports this module, catching the mistake at test time.
//
// All getters read `process.env` at CALL TIME (never cached at module load) so
// per-test env stubbing (vi.stubEnv / direct process.env writes) behaves exactly
// as it did against the raw reads. Var NAMES and values are identical to the
// pre-refactor reads — this is a safety refactor, not a behavior change.

/** Throw a clear, var-NAMED error when a REQUIRED server var is absent/empty. */
export function requireServerEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Read an OPTIONAL server var — `undefined` for absent/empty; caller decides. */
export function optionalServerEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export const serverEnv = {
  // ── Supabase (service role — privileged writes) ──────────────────────────
  supabaseServiceRoleKey: (): string => requireServerEnv("SUPABASE_SERVICE_ROLE_KEY"),

  // ── Stripe ───────────────────────────────────────────────────────────────
  /** Secret key for real Stripe calls (REQUIRED at the call site). */
  stripeSecretKey: (): string => requireServerEnv("STRIPE_SECRET_KEY"),
  /** Non-throwing read for the fail-closed money gate (liveChargesAllowed): a
   *  missing key must yield a CLOSED gate, never an exception. */
  stripeSecretKeyOptional: (): string | undefined => optionalServerEnv("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: (): string | undefined => optionalServerEnv("STRIPE_WEBHOOK_SECRET"),

  // ── QBO / Intuit ───────────────────────────────────────────────────────────
  qboClientId: (): string => requireServerEnv("QBO_CLIENT_ID"),
  qboClientSecret: (): string => requireServerEnv("QBO_CLIENT_SECRET"),
  /** Raw QBO Accounting API base host (REQUIRED, throw-if-unset). The trailing-
   *  slash normalization stays in lib/qbo/constants.ts. */
  qboBaseUrl: (): string => requireServerEnv("QBO_BASE_URL"),
  /** OPTIONAL at the OAuth routes, which keep their own "not configured" guard. */
  qboClientIdOptional: (): string | undefined => optionalServerEnv("QBO_CLIENT_ID"),
  qboRedirectUri: (): string | undefined => optionalServerEnv("QBO_REDIRECT_URI"),
  qboWebhookVerifierToken: (): string | undefined => optionalServerEnv("QBO_WEBHOOK_VERIFIER_TOKEN"),
  qboEnvironment: (): string | undefined => optionalServerEnv("QBO_ENVIRONMENT"),

  // ── MailerSend ─────────────────────────────────────────────────────────────
  appMailersendApiKey: (): string => requireServerEnv("APP_MAILERSEND_API_KEY"),
  mailersendWebhookSecret: (): string | undefined => optionalServerEnv("MAILERSEND_WEBHOOK_SECRET"),

  // ── Anthropic ──────────────────────────────────────────────────────────────
  anthropicApiKey: (): string => requireServerEnv("ANTHROPIC_API_KEY"),

  // ── At-rest secret encryption ──────────────────────────────────────────────
  /** OPTIONAL read; lib/crypto.ts keeps its own presence + 32-byte validation
   *  (and their exact error messages). */
  tokenEncryptionKey: (): string | undefined => optionalServerEnv("TOKEN_ENCRYPTION_KEY"),

  // ── Voice (Vapi) — each route keeps its own "not configured" guard ──────────
  vapiApiKey: (): string | undefined => optionalServerEnv("VAPI_API_KEY"),
  vapiAssistantId: (): string | undefined => optionalServerEnv("VAPI_ASSISTANT_ID"),
  vapiAssistantIdTest: (): string | undefined => optionalServerEnv("VAPI_ASSISTANT_ID_TEST"),
  vapiPhoneNumberId: (): string | undefined => optionalServerEnv("VAPI_PHONE_NUMBER_ID"),
  vapiWebhookSecret: (): string | undefined => optionalServerEnv("VAPI_WEBHOOK_SECRET"),
  /** Voice → email handoff fence (lib/voice/handoffEmail.ts). Exactly "dry_run" or
   *  "live" enables it; unset/empty/anything else = OFF (fail closed). */
  voiceHandoffEmailMode: (): string | undefined => optionalServerEnv("VOICE_HANDOFF_EMAIL_MODE"),
  /** Optional: when set, only this client_id may get a handoff email. */
  voiceHandoffEmailClientId: (): string | undefined => optionalServerEnv("VOICE_HANDOFF_EMAIL_CLIENT_ID"),

  // ── Cron / ops bearer secrets — each route fails closed on a missing value ──
  settlementCronSecret: (): string | undefined => optionalServerEnv("SETTLEMENT_CRON_SECRET"),
  settlementRefundsOpsSecret: (): string | undefined => optionalServerEnv("SETTLEMENT_REFUNDS_OPS_SECRET"),
  outreachRunSecret: (): string | undefined => optionalServerEnv("OUTREACH_RUN_SECRET"),
  outreachCronSecret: (): string | undefined => optionalServerEnv("OUTREACH_CRON_SECRET"),
  qboWorkerCronSecret: (): string | undefined => optionalServerEnv("QBO_WORKER_CRON_SECRET"),

  // ── Outreach cron config (non-secret behavior fences) ──────────────────────
  outreachCronMode: (): string | undefined => optionalServerEnv("OUTREACH_CRON_MODE"),
  outreachCronSubscriberId: (): string | undefined => optionalServerEnv("OUTREACH_CRON_SUBSCRIBER_ID"),
  outreachCronInvoiceId: (): string | undefined => optionalServerEnv("OUTREACH_CRON_INVOICE_ID"),

  // ── Vercel system vars (present on Vercel; absent locally) ──────────────────
  vercelEnv: (): string | undefined => optionalServerEnv("VERCEL_ENV"),
  vercelUrl: (): string | undefined => optionalServerEnv("VERCEL_URL"),
} as const;

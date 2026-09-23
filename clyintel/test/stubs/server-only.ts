// Test stub for the `server-only` package.
//
// The real package's default export THROWS on import (that is how it turns a
// client-side import into a build error). Next.js swaps it for an empty module
// via the "react-server" export condition when bundling Server Components; under
// vitest (plain Node, no react-server condition) the default export would throw
// and break every suite that transitively imports lib/config/env.server.ts.
//
// vitest.config.ts aliases "server-only" to this empty module so those server
// modules load in tests exactly as they do in the real server bundle. The
// client-leak boundary is still enforced at build time by the real package and,
// in tests, by the static assertion in lib/config/env-config.test.ts.
export {};

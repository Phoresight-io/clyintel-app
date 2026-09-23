import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Minimal vitest config: resolve the "@/" path alias (matching tsconfig paths) so
// component tests can import files that use it. Test environment is chosen
// per-file via a `// @vitest-environment jsdom` docblock, so the existing
// Node-environment unit tests are unaffected.
//
// `server-only` is aliased to an empty stub: its real default export throws on
// import (the mechanism that blocks client-side imports at build time), which
// under vitest would break every suite that transitively imports
// lib/config/env.server.ts. Next.js resolves the same package to an empty module
// via the "react-server" condition in the real server build, so this mirrors
// production behavior. The client-leak boundary is still enforced by the real
// package at build time and by the static test in lib/config/env-config.test.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
});

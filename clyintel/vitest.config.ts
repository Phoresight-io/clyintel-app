import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Minimal vitest config: resolve the "@/" path alias (matching tsconfig paths) so
// component tests can import files that use it. Test environment is chosen
// per-file via a `// @vitest-environment jsdom` docblock, so the existing
// Node-environment unit tests are unaffected.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});

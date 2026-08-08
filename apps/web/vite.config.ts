import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Static output, no server.
 *
 * Nothing here holds protocol authority. The app reads chain state directly and builds
 * transactions in the browser, so there is no backend that could become a second source of
 * truth about a settlement. See CLAUDE.md on the Cloudflare and database policy.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@vinct/client": fileURLToPath(
        new URL("../../packages/client/src/index.ts", import.meta.url),
      ),
      "@vinct/monitor": fileURLToPath(
        new URL("../../packages/monitor/src/index.ts", import.meta.url),
      ),
      "@vinct/verifier": fileURLToPath(
        new URL("../../packages/verifier/src/browser.ts", import.meta.url),
      ),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: { port: 5173 },
});

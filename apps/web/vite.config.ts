import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * The build fingerprint, computed here because a browser cannot read the program source.
 *
 * `build.rs` hashes every file under `programs/vinct-core/src` and the program returns that
 * digest from `build_info`. The frontend needs the same value to tell whether a rollup is
 * executing the build it was compiled against, so it is hashed the same way at build time and
 * inlined as a constant. Reading it from the filesystem at runtime is impossible in a browser,
 * and fetching it from a server would make that server a source of truth about correctness.
 */
function programFingerprint(): string {
  const root = fileURLToPath(new URL("../../programs/vinct-core/src", import.meta.url));
  const hasher = createHash("sha256");
  hasher.update(Buffer.from("vinct-core"));
  const walk = (directory: string): void => {
    for (const path of readdirSync(directory)
      .map((name) => join(directory, name))
      .sort()) {
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".rs")) hasher.update(readFileSync(path));
    }
  };
  walk(root);
  return hasher.digest("hex");
}

const CONFIG_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Says so when a production build is about to ship its own RPC endpoint.
 *
 * `VITE_SOLANA_RPC` is a supported override, so this cannot be an error. But unset is what puts
 * the browser on the Worker's `/rpc` proxy, and the proxy is the only reason the upstream
 * credential stays server-side. A value picked up from a stray `.env.local` or an exported shell
 * variable would remove that indirection without anything in the build output admitting it.
 */
function warnOnBakedRpc(mode: string): void {
  if (mode !== "production") return;
  const value = loadEnv(mode, CONFIG_DIR, "VITE_").VITE_SOLANA_RPC;
  if (!value) return;
  console.warn(
    `\n  VITE_SOLANA_RPC is set, so this production bundle will call ${value} directly\n` +
      `  instead of the Worker's /rpc proxy. Intended for a build that means it; otherwise\n` +
      `  unset it and rebuild. Local development belongs in .env.development.local.\n`,
  );
}

/**
 * Static output, no server.
 *
 * Nothing here holds protocol authority. The app reads chain state directly and builds
 * transactions in the browser, so there is no backend that could become a second source of
 * truth about a settlement. See CLAUDE.md on the Cloudflare and database policy.
 */
export default defineConfig(({ mode }) => {
  warnOnBakedRpc(mode);
  return {
    plugins: [react()],
    define: {
      __VINCT_BUILD_FINGERPRINT__: JSON.stringify(programFingerprint()),
      __VINCT_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    },
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
  };
});

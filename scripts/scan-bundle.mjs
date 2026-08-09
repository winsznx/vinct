/**
 * Proves the deployed bundle carries no key material.
 *
 * A local secret scan checks the repository. This checks what a browser actually receives, which
 * is the thing that matters: a credential can enter a bundle through a build-time inline, an
 * environment variable, or a dependency, and none of those is visible in the source tree.
 *
 * Two shapes are looked for. A 64-byte numeric array, because that is a Solana secret key and
 * there is no legitimate reason for one to be shipped. And the credential formats RPC providers
 * actually use, because those arrive in a URL rather than as an obvious key.
 *
 *   node scripts/scan-bundle.mjs https://vinct.timjosh507.workers.dev
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = (process.argv[2] ?? "https://vinct.timjosh507.workers.dev").replace(/\/$/, "");

const html = await (await fetch(url)).text();
const bundlePath = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
if (!bundlePath) throw new Error(`No bundle referenced by ${url}`);
const bundle = await (await fetch(`${url}/${bundlePath}`)).text();

// 64 bytes is a Solana secret key. Nothing shaped like one belongs in a shipped bundle.
const secretKeyShaped = [...bundle.matchAll(/\[((?:\s*\d{1,3}\s*,){63}\s*\d{1,3})\]/g)].filter(
  (match) =>
    match[1]
      .split(",")
      .map(Number)
      .every((value) => value >= 0 && value <= 255),
);

const PATTERNS = {
  "provider api key": /alch_[A-Za-z0-9_-]{16,}|hel_[A-Za-z0-9_-]{16,}/,
  "api key parameter": /[?&](api[-_]?key|apikey|access[-_]?token)=[A-Za-z0-9_-]{8,}/i,
  "private key block": /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  "bearer token": /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
};
const found = Object.entries(PATTERNS)
  .filter(([, pattern]) => pattern.test(bundle))
  .map(([name]) => name);

const clean = secretKeyShaped.length === 0 && found.length === 0;
const record = {
  captured_at: new Date().toISOString(),
  url,
  bundle: bundlePath,
  bundle_bytes: bundle.length,
  question: "Does the deployed bundle contain any key material or credential?",
  solana_secret_key_shaped_arrays: secretKeyShaped.length,
  credential_patterns_found: found,
  clean,
  note:
    "Every signature is produced in the user wallet. The upstream RPC credential is a Cloudflare " +
    "Worker secret and is never sent to the browser; the page calls its own /rpc origin instead.",
};

mkdirSync(join(REPO_ROOT, "artifacts/deployment"), { recursive: true });
writeFileSync(
  join(REPO_ROOT, "artifacts/deployment/bundle-scan.json"),
  `${JSON.stringify(record, null, 2)}\n`,
);

console.log(`${bundlePath}  ${Math.round(bundle.length / 1024)}KB`);
console.log(`  secret-key-shaped arrays: ${secretKeyShaped.length}`);
console.log(`  credential patterns:      ${found.length === 0 ? "none" : found.join(", ")}`);
console.log(clean ? "clean" : "FINDINGS PRESENT");
process.exit(clean ? 0 : 1);

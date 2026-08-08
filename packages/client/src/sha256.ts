/**
 * One SHA-256, usable from Node and from a browser.
 *
 * `node:crypto` is not available in a bundle, and every canonical digest in this repository has
 * to produce identical bytes wherever it runs. `@noble/hashes` is already in the dependency
 * tree beneath `@solana/web3.js`, it is synchronous, and it needs no polyfill, so it replaces
 * `createHash` everywhere the shared packages hash something.
 *
 * The parity that matters is against Rust, and it is asserted by the committed vectors rather
 * than by trusting either implementation.
 */

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

export function sha256(...parts: (Uint8Array | Buffer | string)[]): Buffer {
  const bytes = parts.map((part) =>
    typeof part === "string" ? new TextEncoder().encode(part) : new Uint8Array(part),
  );
  const total = bytes.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of bytes) {
    joined.set(part, offset);
    offset += part.length;
  }
  return Buffer.from(nobleSha256(joined));
}

/**
 * `Buffer`, because the shared packages are written against it.
 *
 * `packages/client` decodes accounts with `Buffer.readBigUInt64LE` and friends, and
 * `@solana/web3.js` v1 assumes `Buffer` exists. Neither is a browser global. Rewriting every
 * decoder against `DataView` would mean two implementations of the layouts that the whole
 * decoder-drift argument exists to prevent, so the browser gets the shim instead.
 *
 * Imported first in `main.tsx`, before anything that touches it. Without it the app dies on
 * load with `Buffer is not defined`, and a blank page is a bad way to learn that.
 */

import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

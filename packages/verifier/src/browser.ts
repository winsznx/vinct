/**
 * The verifier without the parts that need a filesystem.
 *
 * `vectors.ts` reads the committed vector files, which is exactly right for a terminal and
 * impossible in a browser. This entry exposes the canonical encoders and the live-chain
 * operation verification, which are the two things a proof page needs.
 *
 * The split is deliberate rather than a bundler workaround: a page that could read the
 * committed vectors would be checking itself against a file it shipped, which proves nothing.
 * It verifies against the chain instead.
 */

export * from "./canonical.js";
export * from "./operation.js";

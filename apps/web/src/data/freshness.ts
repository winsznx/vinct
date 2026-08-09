/**
 * Is the rollup running the build this frontend was compiled against?
 *
 * The program returns a digest of its own source from `build_info`, and the same digest is
 * computed at build time and inlined here by `vite.config.ts`. Comparing them is the only way
 * to tell a current rollup from one serving a cached executable, because a rollup's account
 * clone of the program data stays perfectly current either way. See docs/decision-log.md D-0040.
 *
 * The observation is a simulation rather than a transaction: it costs nothing, needs no
 * signature, and works from a disconnected browser.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

import { CORE_PROGRAM_ID } from "@vinct/client";

declare const __VINCT_BUILD_FINGERPRINT__: string;
declare const __VINCT_BUILT_AT__: string;

/** sha256("global:build_info")[0..8], the Anchor discriminator. */
const BUILD_INFO_DISCRIMINATOR = "ee7922f6de73e9b5";

export function expectedBuildFingerprint(): string {
  return __VINCT_BUILD_FINGERPRINT__;
}

export function frontendBuiltAt(): string {
  return __VINCT_BUILT_AT__;
}

export async function observedBuildFingerprint(
  connection: Connection,
  feePayer: PublicKey,
): Promise<{ fingerprint: string | null; error?: string }> {
  try {
    const transaction = new Transaction().add(
      new TransactionInstruction({
        programId: CORE_PROGRAM_ID,
        keys: [],
        data: Buffer.from(BUILD_INFO_DISCRIMINATOR, "hex"),
      }),
    );
    transaction.feePayer = feePayer;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const simulation = await connection.simulateTransaction(transaction);

    // The program returns the digest and also logs it. Return data is the reliable one; the log
    // is the fallback for a runtime that truncates it.
    const returned = simulation.value.returnData?.data?.[0];
    if (returned) return { fingerprint: atob(returned) };

    for (const line of simulation.value.logs ?? []) {
      const match = /VINCT_BUILD_FINGERPRINT=([a-f0-9]{64})/.exec(line);
      if (match) return { fingerprint: match[1]! };
    }
    return {
      fingerprint: null,
      error: simulation.value.err ? JSON.stringify(simulation.value.err) : "no fingerprint",
    };
  } catch (cause) {
    return { fingerprint: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Runtime freshness: is the rollup I am about to prove against running the program I built?
 *
 * Phase 3 spent an afternoon on an `InvalidActionCount` that was correct in every account
 * it named. The ER was executing a clone of the program taken before the upgrade, and the
 * only tell was that the Anchor error's line number belonged to the previous build. A
 * successful base-layer upgrade does not propagate to a rollup that has already cached the
 * binary. See docs/decision-log.md D-0030.
 *
 * So before any proof artifact is collected, three values are compared:
 *
 *   expected  the fingerprint computed from the sources in this checkout
 *   base      what the base-layer deployment answers
 *   selected  what the ephemeral rollup about to be used answers
 *
 * All three equal means the run is measuring the current program. Anything else is recorded
 * as stale, and the caller is expected to try another router-resolved endpoint rather than
 * reinterpret the mismatch as an application bug. No region is ever hardcoded here.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

import { CORE_IDL, CORE_PROGRAM_ID, discriminator } from "./ids.js";
import { withDiscriminator } from "./encoding.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CORE_SRC = join(REPO_ROOT, "programs", "vinct-core", "src");
const RETURN_PREFIX = "VINCT_BUILD_FINGERPRINT=";

/**
 * Recomputes the fingerprint `programs/vinct-core/build.rs` emits.
 *
 * Reimplemented rather than read out of the built artifact on purpose. If the two ever
 * disagree, that is a real finding: it means the binary on disk was not built from the
 * sources in this checkout.
 */
export function expectedBuildFingerprint(): string {
  const hasher = createHash("sha256");
  hasher.update(Buffer.from("vinct-core"));
  walk(CORE_SRC, hasher);
  return hasher.digest("hex");
}

function walk(directory: string, hasher: ReturnType<typeof createHash>): void {
  const entries = readdirSync(directory).map((name) => join(directory, name));
  entries.sort();
  for (const path of entries) {
    if (statSync(path).isDirectory()) {
      walk(path, hasher);
    } else if (path.endsWith(".rs")) {
      hasher.update(Buffer.from(relative(CORE_SRC, path).split(sep).join("/")));
      hasher.update(readFileSync(path));
    }
  }
}

export function buildInfoInstruction(): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [],
    data: withDiscriminator(discriminator(CORE_IDL, "build_info")),
  });
}

/**
 * Asks one runtime what it is running.
 *
 * Simulated rather than sent. A freshness check that costs a transaction would be one more
 * thing to skip when a run is in a hurry, and simulation reaches the same loaded program.
 */
export async function observedBuildFingerprint(
  connection: Connection,
  feePayer: PublicKey,
): Promise<{ fingerprint: string | null; source: "returnData" | "log" | null; error?: string }> {
  try {
    const transaction = new Transaction().add(buildInfoInstruction());
    transaction.feePayer = feePayer;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const simulation = await connection.simulateTransaction(transaction);

    const returned = simulation.value.returnData?.data?.[0];
    if (returned) {
      return {
        fingerprint: Buffer.from(returned, "base64").toString("utf8"),
        source: "returnData",
      };
    }
    for (const line of simulation.value.logs ?? []) {
      const index = line.indexOf(RETURN_PREFIX);
      if (index >= 0) {
        return { fingerprint: line.slice(index + RETURN_PREFIX.length).trim(), source: "log" };
      }
    }
    return {
      fingerprint: null,
      source: null,
      error: simulation.value.err
        ? JSON.stringify(simulation.value.err)
        : "no fingerprint returned",
    };
  } catch (cause) {
    return {
      fingerprint: null,
      source: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export interface FreshnessReport {
  expected: string;
  base: { endpoint: string; fingerprint: string | null; error?: string };
  selected: { endpoint: string; fingerprint: string | null; error?: string };
  baseMatchesExpected: boolean;
  selectedMatchesBase: boolean;
  /** True only when all three agree. Nothing else may be treated as fresh. */
  fresh: boolean;
  verdict: "FRESH" | "STALE_ER" | "STALE_BASE" | "UNDETERMINED";
  note: string;
}

export async function checkRuntimeFreshness(options: {
  base: Connection;
  baseEndpoint: string;
  ephemeral: Connection;
  ephemeralEndpoint: string;
  feePayer: PublicKey;
}): Promise<FreshnessReport> {
  const expected = expectedBuildFingerprint();
  const [baseAnswer, erAnswer] = await Promise.all([
    observedBuildFingerprint(options.base, options.feePayer),
    observedBuildFingerprint(options.ephemeral, options.feePayer),
  ]);

  const baseMatchesExpected = baseAnswer.fingerprint === expected;
  const selectedMatchesBase =
    baseAnswer.fingerprint !== null && erAnswer.fingerprint === baseAnswer.fingerprint;
  const fresh = baseMatchesExpected && selectedMatchesBase;

  let verdict: FreshnessReport["verdict"];
  let note: string;
  if (fresh) {
    verdict = "FRESH";
    note =
      "The checkout, the base-layer deployment, and the selected rollup all report the same build.";
  } else if (baseAnswer.fingerprint === null || erAnswer.fingerprint === null) {
    verdict = "UNDETERMINED";
    note =
      "At least one runtime did not answer build_info. Treat this as not fresh: an unanswered check is not a passed check.";
  } else if (!baseMatchesExpected) {
    verdict = "STALE_BASE";
    note =
      "The base-layer program is not the build in this checkout. Deploy or upgrade before collecting evidence.";
  } else {
    verdict = "STALE_ER";
    note =
      "The selected rollup is executing a cached clone of an older build. Do not collect artifacts from it; resolve another endpoint from live routing.";
  }

  return {
    expected,
    base: {
      endpoint: options.baseEndpoint,
      fingerprint: baseAnswer.fingerprint,
      ...(baseAnswer.error ? { error: baseAnswer.error } : {}),
    },
    selected: {
      endpoint: options.ephemeralEndpoint,
      fingerprint: erAnswer.fingerprint,
      ...(erAnswer.error ? { error: erAnswer.error } : {}),
    },
    baseMatchesExpected,
    selectedMatchesBase,
    fresh,
    verdict,
    note,
  };
}

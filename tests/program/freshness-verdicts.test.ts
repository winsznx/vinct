/**
 * The freshness gate's verdict logic.
 *
 * A gate is only worth having if it can say no, and this one guards whether any Devnet
 * evidence gets collected at all. The Devnet side is covered by a real blocked run
 * (`artifacts/devnet/phase4-per-phase4-stale-gate-latest.json`); this covers the part that
 * decides which kind of no it is, including the case that is easiest to get wrong.
 *
 *   pnpm exec tsx --test tests/program/freshness-verdicts.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Keypair } from "@solana/web3.js";

import {} from "../../packages/client/src/index.js";
import {
  checkRuntimeFreshness,
  expectedBuildFingerprint,
} from "../../packages/client/src/freshness.js";

const feePayer = Keypair.generate().publicKey;

/**
 * A stand-in for a runtime that answers `build_info` with whatever we tell it to.
 *
 * `checkRuntimeFreshness` only calls `getLatestBlockhash` and `simulateTransaction`, so this
 * is the whole surface it touches.
 */
function runtime(fingerprint: string | null): never {
  const value =
    fingerprint === null
      ? { returnData: null, logs: [], err: "AccountNotFound" }
      : {
          returnData: { data: [Buffer.from(fingerprint, "utf8").toString("base64"), "base64"] },
          logs: [],
          err: null,
        };
  return {
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111" }),
    simulateTransaction: async () => ({ value }),
  } as never;
}

async function verdictFor(base: string | null, ephemeral: string | null): Promise<string> {
  const report = await checkRuntimeFreshness({
    base: runtime(base),
    baseEndpoint: "base",
    ephemeral: runtime(ephemeral),
    ephemeralEndpoint: "ephemeral",
    feePayer,
  });
  return report.verdict;
}

const CURRENT = expectedBuildFingerprint();
const OTHER = "0".repeat(64);

test("all three agreeing is the only way to be fresh", async () => {
  const report = await checkRuntimeFreshness({
    base: runtime(CURRENT),
    baseEndpoint: "base",
    ephemeral: runtime(CURRENT),
    ephemeralEndpoint: "ephemeral",
    feePayer,
  });
  assert.equal(report.verdict, "FRESH");
  assert.equal(report.fresh, true);
});

test("a rollup behind the deployment is STALE_ER", async () => {
  assert.equal(await verdictFor(CURRENT, OTHER), "STALE_ER");
});

test("a deployment behind the checkout is STALE_BASE", async () => {
  assert.equal(await verdictFor(OTHER, OTHER), "STALE_BASE");
});

/**
 * The case worth writing down.
 *
 * A runtime that fails to answer has not told us it is current. Treating silence as a pass
 * is how a gate stops being a gate, so both the unanswered cases resolve to UNDETERMINED and
 * `fresh` stays false.
 */
test("silence is not a pass", async () => {
  for (const [base, ephemeral] of [
    [CURRENT, null],
    [null, CURRENT],
    [null, null],
  ] as const) {
    const report = await checkRuntimeFreshness({
      base: runtime(base),
      baseEndpoint: "base",
      ephemeral: runtime(ephemeral),
      ephemeralEndpoint: "ephemeral",
      feePayer,
    });
    assert.equal(report.verdict, "UNDETERMINED");
    assert.equal(report.fresh, false);
  }
});

/**
 * The fingerprint has to change when the sources change, or the gate compares a constant.
 *
 * Recomputing it twice over an unchanged tree must give the same answer, which is what makes
 * it usable as an identity rather than a timestamp.
 */
test("the expected fingerprint is stable and non-trivial", () => {
  assert.match(CURRENT, /^[0-9a-f]{64}$/);
  assert.equal(expectedBuildFingerprint(), CURRENT);
  assert.notEqual(CURRENT, OTHER);
});

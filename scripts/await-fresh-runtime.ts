/**
 * Waits for an ephemeral rollup to start executing the build in this checkout.
 *
 * A rollup caches a program's executable the first time it runs it, and a base-layer upgrade
 * does not evict that cache. Its account clone of the program data stays perfectly current,
 * which is what makes the situation confusing: everything looks deployed, and the rollup
 * quietly keeps running the previous binary. See docs/decision-log.md D-0030 and D-0040.
 *
 * Nothing VINCT can send clears it. A fresh delegation does not, and neither does a real
 * transaction that invokes the program. When the only attested endpoint is stale there is
 * nowhere to fail over to, so the honest answer is to wait and re-probe.
 *
 *   pnpm exec tsx scripts/await-fresh-runtime.ts
 *   pnpm exec tsx scripts/await-fresh-runtime.ts --once
 *
 * Exits 0 the moment the rollup reports the expected fingerprint, 1 if the window runs out.
 * Pair it with the Phase 4 runner, which refuses to collect anything until this is true:
 *
 *   pnpm exec tsx scripts/await-fresh-runtime.ts && pnpm exec tsx scripts/phase4-per.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair } from "@solana/web3.js";

import {
  expectedBuildFingerprint,
  observedBuildFingerprint,
} from "../packages/client/src/freshness.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_RPC = process.env.VINCT_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
const ROUTER = process.env.VINCT_ROUTER ?? "https://devnet-router.magicblock.app/";
const KEYPAIR = process.env.VINCT_KEYPAIR ?? ".toolchain/keys/devnet-deployer.json";
const INTERVAL_MS = Number.parseInt(process.env.VINCT_POLL_INTERVAL_MS ?? "60000", 10);
const ATTEMPTS = Number.parseInt(process.env.VINCT_POLL_ATTEMPTS ?? "240", 10);
const ONCE = process.argv.includes("--once");
/** Only look at attested endpoints, since those are the ones a PER run can use. */
const ATTESTED_ONLY = !process.argv.includes("--any-endpoint");

interface Route {
  identity: string;
  fqdn: string;
}

async function routes(): Promise<Route[]> {
  const response = await fetch(ROUTER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRoutes" }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { result?: Route[] };
  return body.result ?? [];
}

async function main(): Promise<void> {
  const expected = expectedBuildFingerprint();
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(REPO_ROOT, KEYPAIR), "utf8")) as number[]),
  );

  const candidates: Route[] = [];
  for (const route of await routes()) {
    if (!ATTESTED_ONLY) {
      candidates.push(route);
      continue;
    }
    try {
      await verifyTeeRpcIntegrity(route.fqdn.replace(/\/$/, ""));
      candidates.push(route);
    } catch {
      // Not attested, so not a candidate for a PER run.
    }
  }
  if (candidates.length === 0) {
    console.error("no attested rollup is advertised right now");
    process.exitCode = 1;
    return;
  }

  console.log(`expecting ${expected.slice(0, 16)}…`);
  const baseAnswer = await observedBuildFingerprint(
    new Connection(BASE_RPC, "confirmed"),
    payer.publicKey,
  );
  console.log(
    `  base      ${baseAnswer.fingerprint?.slice(0, 16) ?? baseAnswer.error} ${baseAnswer.fingerprint === expected ? "current" : "STALE — deploy first"}`,
  );
  if (baseAnswer.fingerprint !== expected) {
    console.error(
      "the base-layer deployment is not this checkout's build; waiting would be futile",
    );
    process.exitCode = 1;
    return;
  }

  for (let attempt = 1; attempt <= (ONCE ? 1 : ATTEMPTS); attempt += 1) {
    for (const route of candidates) {
      const answer = await observedBuildFingerprint(
        new Connection(route.fqdn, "confirmed"),
        payer.publicKey,
      );
      const stamp = new Date().toISOString();
      if (answer.fingerprint === expected) {
        console.log(`[${attempt}] ${stamp} ${route.fqdn} FRESH`);
        return;
      }
      console.log(
        `[${attempt}] ${stamp} ${route.fqdn} ${answer.fingerprint?.slice(0, 16) ?? answer.error}`,
      );
    }
    if (ONCE) break;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  console.error("no attested rollup picked up the current build within the polling window");
  process.exitCode = 1;
}

await main();

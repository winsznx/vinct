/**
 * Which rollups are executing the build in this checkout.
 *
 * A rollup caches a program executable the first time it runs it, and a base-layer upgrade does
 * not evict that cache. The account clone stays current, so everything looks deployed while the
 * rollup quietly keeps running the previous binary. See docs/decision-log.md D-0030 and D-0040.
 *
 * The attestation probe answers a different question, so this one is separate: a rollup can be
 * attested and stale, or fresh and not attested, and the two facts constrain different claims.
 * Phase 4's privacy evidence needs an attested rollup. The composition needs a fresh one. When
 * no rollup is both, the honest move is to say which claim each one can carry.
 *
 *   pnpm exec tsx scripts/probe-runtimes.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair } from "@solana/web3.js";

import {
  expectedBuildFingerprint,
  observedBuildFingerprint,
} from "../packages/client/src/freshness.js";
import { redactEndpoint } from "../packages/client/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTER = process.env.VINCT_ROUTER ?? "https://devnet-router.magicblock.app/";
const KEYPAIR = process.env.VINCT_KEYPAIR ?? ".toolchain/keys/devnet-deployer.json";
const BASE_RPC = process.env.VINCT_BASE_RPC ?? "https://rpc.magicblock.app/devnet";

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8")) as number[]),
);
const expected = expectedBuildFingerprint();

const response = await fetch(ROUTER, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRoutes", params: [] }),
});
const routes =
  ((await response.json()) as { result?: { fqdn: string; identity: string }[] }).result ?? [];

console.log(`expected  ${expected.slice(0, 16)}  (this checkout)`);
const base = await observedBuildFingerprint(new Connection(BASE_RPC, "confirmed"), payer.publicKey);
console.log(
  `base      ${base.fingerprint?.slice(0, 16) ?? "no answer"}  ${redactEndpoint(BASE_RPC)}`,
);
console.log();

const records: {
  fqdn: string;
  identity: string;
  fingerprint: string | null;
  fresh: boolean;
  attested: boolean;
  error?: string;
}[] = [];

for (const route of routes) {
  const observed = await observedBuildFingerprint(
    new Connection(route.fqdn, "confirmed"),
    payer.publicKey,
  );
  let attested = false;
  try {
    await verifyTeeRpcIntegrity(route.fqdn.replace(/\/$/, ""));
    attested = true;
  } catch {
    attested = false;
  }
  const fresh = observed.fingerprint === expected;
  console.log(
    `${fresh ? "FRESH" : "stale"}  ${attested ? "attested    " : "not attested"}  ` +
      `${observed.fingerprint?.slice(0, 16) ?? "no answer   "}  ${route.fqdn}`,
  );
  if (observed.error) console.log(`         ${observed.error}`);
  records.push({
    fqdn: route.fqdn,
    identity: route.identity,
    fingerprint: observed.fingerprint,
    fresh,
    attested,
    ...(observed.error ? { error: observed.error } : {}),
  });
}

// Attestation and freshness are independent, and a run that found no rollup with both is the
// reason a confidentiality claim and a mechanism claim cannot share an artifact.
const both = records.filter((r) => r.fresh && r.attested);
console.log();
console.log(
  both.length > 0
    ? `${both.length} rollup(s) both fresh and attested`
    : "no rollup is both fresh and attested",
);

const directory = join(REPO_ROOT, "artifacts", "devnet");
mkdirSync(directory, { recursive: true });
writeFileSync(
  join(directory, "runtime-freshness.json"),
  `${JSON.stringify(
    {
      captured_at: new Date().toISOString(),
      question:
        "Which router-advertised rollups execute the build in this checkout, and which answer a TDX quote?",
      expected_fingerprint: expected,
      base: { endpoint: redactEndpoint(BASE_RPC), fingerprint: base.fingerprint },
      rollups: records,
      any_fresh_and_attested: both.length > 0,
      note: "A rollup caches a program executable the first time it runs it and a base-layer upgrade does not evict that cache. Attestation and freshness are separate properties and constrain different claims.",
    },
    null,
    2,
  )}\n`,
);
console.log("Wrote artifacts/devnet/runtime-freshness.json");

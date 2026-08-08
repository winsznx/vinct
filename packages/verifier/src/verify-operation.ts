/**
 * Standalone verification of one settled operation, against a live cluster.
 *
 * Takes a run artifact for the addresses to look at, and then verifies nothing from it. Every
 * value that gets checked is read off the chain and recomputed here.
 *
 *   pnpm verify-operation artifacts/local-stack/phase5-composition-success.json
 *   pnpm verify-operation <artifact> --rpc https://api.devnet.solana.com
 */

import { readFileSync } from "node:fs";

import { Connection, PublicKey } from "@solana/web3.js";

import { verifyOperation } from "./operation.js";

interface RunArtifact {
  incident: string;
  certificate: string;
  settlement_receipt: string;
  endpoints?: { base?: string };
  settlement_record?: { expectedActions?: { actionIndex: number; label: string }[] };
  adapter_receipts?: { label: string; address: string }[];
}

const [artifactPath, ...rest] = process.argv.slice(2);
if (!artifactPath) {
  console.error("usage: verify-operation <run-artifact.json> [--rpc <url>]");
  process.exit(2);
}

const rpcFlag = rest.indexOf("--rpc");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as RunArtifact;
const rpc =
  (rpcFlag >= 0 ? rest[rpcFlag + 1] : undefined) ??
  artifact.endpoints?.base ??
  "http://127.0.0.1:8899";

const connection = new Connection(rpc, "confirmed");
const verification = await verifyOperation(connection, {
  incidentCore: new PublicKey(artifact.incident),
  certificate: new PublicKey(artifact.certificate),
  settlementReceipt: new PublicKey(artifact.settlement_receipt),
  adapterReceipts: (artifact.adapter_receipts ?? []).map((receipt) => ({
    label: receipt.label,
    address: new PublicKey(receipt.address),
  })),
});

console.log(`independent verification of ${artifactPath}`);
console.log(`  cluster ${rpc}`);
console.log(`  recorded  ${verification.operationId}`);
console.log(`  derived   ${verification.derivedOperationId}`);
console.log("");
for (const check of verification.checks) {
  console.log(`  ${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
  if (!check.passed) console.log(`        ${check.detail}`);
}
console.log("");
console.log("  delivery (reported, not verified — a bound receipt is not a settled one)");
console.log(`    settlement receipt finalized: ${verification.delivery.settlementFinalized}`);
for (const adapter of verification.delivery.adapters) {
  console.log(
    `    ${adapter.label}: executed=${adapter.executed} target effect=${adapter.targetEffectApplied}`,
  );
}
console.log("");
console.log(verification.verified ? "VERIFIED" : "NOT VERIFIED");
process.exit(verification.verified ? 0 : 1);

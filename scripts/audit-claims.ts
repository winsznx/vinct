/**
 * The claim ledger, audited against what actually exists.
 *
 * A ledger is only worth anything if every row can be checked, and a row naming an artifact
 * that was never written is worse than no row at all: it reads as evidence and is a promise.
 * That happened once, and this is the gate that stops it happening again.
 *
 * Checks each claim for a source commit that exists in this repository's history, artifact
 * files present on disk, at least one reproducing command, recorded limitations, and a proof
 * level consistent with the evidence attached. Nothing here judges whether a claim is true;
 * that is what the tests and the artifacts are for. It judges whether a reader could find out.
 *
 *   pnpm audit-claims
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Claim {
  id: string;
  wording: string;
  status: string;
  proof_level: number;
  network: string;
  source_commit: string;
  program_ids: string[];
  transactions: string[];
  commands: string[];
  artifacts: string[];
  verified_at: string;
  limitations: string[];
}

const claims = JSON.parse(
  readFileSync(join(REPO_ROOT, "docs", "claim-ledger.json"), "utf8"),
) as Claim[];

const problems: { id: string; problem: string }[] = [];
const note = (id: string, problem: string): void => {
  problems.push({ id, problem });
};

/** Every commit named by a claim has to be reachable, or the claim points at nothing. */
function commitExists(sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const seen = new Set<string>();

for (const claim of claims) {
  if (seen.has(claim.id)) note(claim.id, "duplicate id");
  seen.add(claim.id);

  if (claim.status !== "verified") {
    note(claim.id, `status is "${claim.status}"; the ledger holds verified claims only`);
  }
  if (!claim.source_commit || claim.source_commit === "PENDING") {
    note(claim.id, "no source commit");
  } else if (!commitExists(claim.source_commit)) {
    note(claim.id, `source commit ${claim.source_commit} is not in this history`);
  }
  if (claim.commands.length === 0) {
    note(claim.id, "no command reproduces it");
  }
  if (claim.limitations.length === 0) {
    // Every claim has a boundary. A claim with none recorded has an unexamined one.
    note(claim.id, "no limitations recorded");
  }
  for (const artifact of claim.artifacts) {
    if (!existsSync(join(REPO_ROOT, artifact))) {
      note(claim.id, `artifact does not exist: ${artifact}`);
    }
  }

  // A claim about a live network has to carry something from that network. Proof levels at or
  // above 5 mean "observed on a running system", and an observation nobody wrote down is a
  // memory.
  const live = claim.network !== "none" && claim.network !== "litesvm";
  if (claim.proof_level >= 5 && claim.artifacts.length === 0) {
    note(claim.id, `proof level ${claim.proof_level} with no artifact`);
  }
  if (live && claim.proof_level >= 5 && claim.artifacts.length === 0) {
    note(claim.id, `claims ${claim.network} at level ${claim.proof_level} with nothing recorded`);
  }
  if (!claim.wording.trim()) note(claim.id, "empty wording");
}

const byNetwork = new Map<string, number>();
for (const claim of claims) {
  byNetwork.set(claim.network, (byNetwork.get(claim.network) ?? 0) + 1);
}

console.log(`claim ledger: ${claims.length} claims`);
for (const [network, count] of [...byNetwork].sort()) {
  console.log(`  ${String(count).padStart(3)}  ${network}`);
}
console.log();

if (problems.length === 0) {
  console.log("every claim is stamped, reproducible, bounded, and backed by files that exist");
  process.exit(0);
}

console.error(`${problems.length} problem(s):`);
for (const { id, problem } of problems) {
  console.error(`  ${id}`);
  console.error(`    ${problem}`);
}
process.exit(1);

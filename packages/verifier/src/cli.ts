/**
 * Standalone canonical-vector verifier.
 *
 * Reads the vectors Rust generated and proves this package's independent encoder agrees
 * with them, byte for byte. Exits non-zero on any disagreement.
 *
 *   pnpm verify-vectors
 */

import { loadVectors, templateRoundTrips, verifyVectors } from "./vectors.js";

const vectors = loadVectors(process.argv[2]);
const failures = verifyVectors(vectors);

if (!templateRoundTrips(vectors)) {
  failures.push({
    entry: "bundle_template",
    check: "decode/encode round trip",
    expected: "identical bytes",
    actual: "differs",
  });
}

const checked =
  vectors.domains.length +
  vectors.members.entries.length +
  vectors.action_templates.length +
  vectors.action_bundle_mutations.length +
  7;

if (failures.length === 0) {
  console.log(`canonical vectors verified: ${checked} entries, schema ${vectors.schema}`);
  console.log(`  operation_id      ${vectors.operation_id.sha256}`);
  console.log(`  action_bundle     ${vectors.action_bundle.sha256}`);
  console.log(`  certificate       ${vectors.certificate.sha256}`);
  console.log(`  mutations checked ${vectors.action_bundle_mutations.length}`);
  process.exit(0);
}

console.error(`canonical vector parity FAILED: ${failures.length} disagreement(s)`);
for (const failure of failures) {
  console.error(`  ${failure.entry} / ${failure.check}`);
  console.error(`    expected ${failure.expected}`);
  console.error(`    actual   ${failure.actual}`);
}
process.exit(1);

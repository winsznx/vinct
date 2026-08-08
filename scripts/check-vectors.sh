#!/usr/bin/env bash
#
# Fails when the committed vectors are not what the Rust would generate today.
#
# The vectors are the only thing tying the TypeScript encoders and decoders to the Rust
# definitions. If a Rust struct gains a field and nobody regenerates, the vectors keep
# describing the old layout and the parity tests keep passing against it. Both sides agree,
# and both are wrong. That happened once with ActionTemplateV1; see docs/decision-log.md
# D-0055.
#
# Run before any push. Regenerating is the fix, never editing a vector by hand.
#
#   bash scripts/check-vectors.sh

set -euo pipefail

cd "$(dirname "$0")/.."

pnpm gen-vectors
pnpm gen-account-vectors

if ! git diff --quiet -- packages/test-vectors; then
  echo ""
  echo "FAIL: the committed vectors are stale."
  echo "A Rust definition changed and the vectors were not regenerated, so every"
  echo "cross-language parity test has been checking the TypeScript against a layout"
  echo "that no longer exists."
  echo ""
  git --no-pager diff --stat -- packages/test-vectors
  echo ""
  echo "Regenerate, then bring the TypeScript encoders and decoders back into line:"
  echo "  pnpm gen-vectors && pnpm gen-account-vectors"
  exit 1
fi

echo "vectors are current"

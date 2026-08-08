#!/usr/bin/env bash
#
# The browser evidence, produced against a chain rather than a fixture.
#
# Runs a real composition on the local stack, takes the covenant and operation it produced, and
# points the browser suite at them. A run that used a fixture would prove the page renders and
# nothing about whether it reads a chain correctly, which is the only interesting question.
#
# Video is on for every test, so the artifact is a recording of the paths a judge takes.
#
#   bash scripts/phase7-web-proof.sh

set -euo pipefail

cd "$(dirname "$0")/.."

BASE_RPC=${VINCT_BASE_RPC:-http://127.0.0.1:8899}

if ! curl -s -X POST "$BASE_RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then
  echo "FAIL: no base layer at $BASE_RPC. Run: bash scripts/bootstrap-local.sh start"
  exit 1
fi

echo "==> composing a real incident so the browser has something true to read"
pnpm exec tsx scripts/phase5-composition.ts

ARTIFACT=artifacts/local-stack/phase5-composition-success.json
VINCT_COVENANT=$(python3 -c "import json;print(json.load(open('$ARTIFACT'))['covenant'])")
VINCT_OPERATION=$(python3 -c "import json;print(json.load(open('$ARTIFACT'))['operation_id'])")
export VINCT_COVENANT VINCT_OPERATION

echo "==> covenant  $VINCT_COVENANT"
echo "==> operation $VINCT_OPERATION"

echo "==> building the app that will be tested, not a dev server"
pnpm --filter @vinct/web build

echo "==> browser suite, desktop and mobile, video on"
pnpm exec playwright test

echo
echo "Video and traces: artifacts/web/test-results"
echo "Report:           artifacts/web/report/index.html"

#!/usr/bin/env bash
# Starts and stops the pinned local MagicBlock stack (base validator + ephemeral
# validator + query filtering service) as one supervised process.
#
#   scripts/bootstrap-local.sh start   # start and wait until all services report ready
#   scripts/bootstrap-local.sh stop    # stop and verify no child process survives
#   scripts/bootstrap-local.sh status  # report what is currently running
#   scripts/bootstrap-local.sh cycle   # start, verify, stop, verify — the Phase 0 gate
#
# The local stack proves delegation, ER writes, commit, and undelegation routing.
# It does not prove router discovery, TEE-backed PER confidentiality, crank
# scheduling, or Magic Action delivery. Do not report those from a local run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./toolchain-env.sh
. "$SCRIPT_DIR/toolchain-env.sh"

STATE_DIR="$VINCT_ROOT/.toolchain/local-stack"
PID_FILE="$STATE_DIR/mb-stack.pid"
LOG_FILE="$STATE_DIR/mb-stack.log"
ARTIFACT_DIR="$VINCT_ROOT/artifacts/local-stack"
READY_TIMEOUT="${VINCT_STACK_READY_TIMEOUT:-240}"
STOP_TIMEOUT="${VINCT_STACK_STOP_TIMEOUT:-30}"

# Every process name mb-stack supervises. Used only to assert a clean shutdown —
# never to decide that the stack is healthy.
SUPERVISED_PATTERNS=(
  "mb-stack"
  "mb-test-validator"
  "ephemeral-validator"
  "query-filtering-service"
  "solana-test-validator"
)

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

survivors() {
  local pattern found=""
  for pattern in "${SUPERVISED_PATTERNS[@]}"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      found="$found $pattern"
    fi
  done
  printf '%s' "${found# }"
}

rpc_ok() {
  local url="$1"
  curl -sS -m 3 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$url" 2>/dev/null \
    | grep -q '"result"'
}

cmd_start() {
  local existing
  existing="$(survivors)"
  [ -z "$existing" ] || die "processes already running:$existing. Run 'stop' first."

  command -v pnpm >/dev/null 2>&1 || die "pnpm is required"
  [ -d "$VINCT_ROOT/node_modules" ] || die "run 'pnpm install' first"

  mkdir -p "$STATE_DIR"
  rm -rf "$VINCT_ROOT/magicblock-test-storage" "$LOG_FILE"

  # The ephemeral validator refuses to start unless its identity holds at least
  # 5 SOL on base. The dump shipped with @magicblock-labs/ephemeral-validator
  # 0.13.19 funds it with 0.053432154 SOL, so the stack cannot boot from package
  # defaults alone. Extra mb-stack arguments are forwarded to solana-test-validator
  # and applied last, so re-declaring the same account overrides the packaged dump.
  local identity_fixture="$VINCT_ROOT/scripts/fixtures/local-er-validator-identity.json"
  [ -f "$identity_fixture" ] || die "missing $identity_fixture"

  log "Starting pinned local stack (@magicblock-labs/ephemeral-validator@$VINCT_EPHEMERAL_VALIDATOR_VERSION)"
  (
    cd "$VINCT_ROOT"
    RUST_LOG=info pnpm exec mb-stack --reset \
      --account mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev "$identity_fixture" \
      >"$LOG_FILE" 2>&1 </dev/null &
    echo $! >"$PID_FILE"
  )

  local pid
  pid="$(cat "$PID_FILE")"

  local waited=0
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "--- last 80 log lines ---"
      tail -80 "$LOG_FILE" 2>/dev/null || true
      die "mb-stack exited before reporting ready"
    fi
    if grep -q "MagicBlock stack is ready" "$LOG_FILE" 2>/dev/null; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ "$waited" -ge "$READY_TIMEOUT" ]; then
    log "--- last 80 log lines ---"
    tail -80 "$LOG_FILE" 2>/dev/null || true
    die "mb-stack did not report ready within ${READY_TIMEOUT}s"
  fi

  # The readiness line comes from mb-stack's own health gate. Independently probe
  # each endpoint so a log-format change cannot be mistaken for a healthy stack.
  local endpoint
  for endpoint in "$VINCT_BASE_RPC" "$VINCT_ER_RPC" "$VINCT_QFS_RPC"; do
    rpc_ok "$endpoint" || die "getHealth failed for $endpoint"
  done

  log "Ready after ${waited}s. base=$VINCT_BASE_RPC er=$VINCT_ER_RPC qfs=$VINCT_QFS_RPC"
}

cmd_stop() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill -TERM "$pid" 2>/dev/null || true
  fi

  local waited=0
  while [ "$waited" -lt "$STOP_TIMEOUT" ]; do
    [ -z "$(survivors)" ] && break
    sleep 1
    waited=$((waited + 1))
  done

  # mb-stack signals its own children on SIGTERM. Escalate only if something is
  # still alive, so a normal shutdown never depends on pattern-matched kills.
  if [ -n "$(survivors)" ]; then
    log "escalating to SIGKILL for:$(survivors)"
    local pattern
    for pattern in "${SUPERVISED_PATTERNS[@]}"; do
      pkill -9 -f "$pattern" 2>/dev/null || true
    done
    sleep 2
  fi

  rm -f "$PID_FILE"

  local remaining
  remaining="$(survivors)"
  [ -z "$remaining" ] || die "processes survived shutdown:$remaining"
  log "Stopped cleanly. No supervised process survived."
}

cmd_status() {
  local running
  running="$(survivors)"
  if [ -z "$running" ]; then
    log "stopped"
  else
    log "running:$running"
  fi
}

cmd_cycle() {
  mkdir -p "$ARTIFACT_DIR"
  local started_at ended_at report
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cmd_start
  cmd_status
  cmd_stop
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  report="$ARTIFACT_DIR/stack-lifecycle.json"
  cat >"$report" <<EOF
{
  "started_at": "$started_at",
  "ended_at": "$ended_at",
  "ephemeral_validator": "$VINCT_EPHEMERAL_VALIDATOR_VERSION",
  "solana_cli": "$("$VINCT_SOLANA_BIN/solana" --version 2>/dev/null | awk '{print $2}')",
  "base_rpc": "$VINCT_BASE_RPC",
  "er_rpc": "$VINCT_ER_RPC",
  "qfs_rpc": "$VINCT_QFS_RPC",
  "health_probe": "getHealth returned a result for base, er, and qfs",
  "clean_shutdown": true,
  "surviving_processes": [],
  "not_proven": [
    "router getDelegationStatus discovery",
    "TEE-backed PER confidentiality",
    "crank scheduler registration and iteration",
    "Magic Action base-layer delivery"
  ]
}
EOF
  log "Wrote $report"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  cycle) cmd_cycle ;;
  *)
    log "usage: $0 {start|stop|status|cycle}"
    exit 64
    ;;
esac

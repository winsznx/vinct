#!/usr/bin/env bash
# Accumulates Devnet SOL into the project deployer.
#
# The devnet faucets rate-limit hard: roughly one grant per interval per source, regardless
# of how many addresses ask. This script works with that rather than against it. It walks a
# pool of throwaway keypairs, asks each faucet in turn, sweeps whatever lands into the
# deployer, and sleeps between rounds. It is safe to run for a long time and safe to
# interrupt: every lamport it obtains is swept before the next round.
#
#   bash scripts/fund-devnet.sh              # top up to the default target
#   bash scripts/fund-devnet.sh 8            # top up to 8 SOL
#
# Throwaway funder keys live in .toolchain/keys/funders and are gitignored. They hold no
# value worth protecting; they exist only because a faucet grants per address.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./toolchain-env.sh
. "$SCRIPT_DIR/toolchain-env.sh"

TARGET_SOL="${1:-6}"
DEPLOYER_KEY="$VINCT_ROOT/.toolchain/keys/devnet-deployer.json"
FUNDER_DIR="$VINCT_ROOT/.toolchain/keys/funders"
POOL_SIZE="${VINCT_FUNDER_POOL:-6}"
ROUND_SLEEP="${VINCT_FUND_ROUND_SLEEP:-45}"
MAX_ROUNDS="${VINCT_FUND_MAX_ROUNDS:-200}"

# Every faucet worth asking. The MagicBlock devnet RPC and the public devnet RPC are
# independent sources with independent limits, so both are tried each round.
FAUCETS=(
  "https://rpc.magicblock.app/devnet"
  "https://api.devnet.solana.com"
)

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

balance_lamports() {
  local address="$1"
  local raw
  raw="$(solana balance "$address" -u "${FAUCETS[0]}" --lamports 2>/dev/null || true)"
  printf '%s' "${raw%% *}" | grep -oE '^[0-9]+' || printf '0'
}

request_airdrop() {
  local rpc="$1" address="$2" lamports="$3"
  curl -sS -m 25 -X POST -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$address\",$lamports]}" \
    "$rpc" 2>/dev/null
}

[ -f "$DEPLOYER_KEY" ] || {
  mkdir -p "$(dirname "$DEPLOYER_KEY")"
  solana-keygen new --no-bip39-passphrase --silent -o "$DEPLOYER_KEY"
}
DEPLOYER="$(solana address -k "$DEPLOYER_KEY")"

mkdir -p "$FUNDER_DIR"
for index in $(seq 1 "$POOL_SIZE"); do
  key="$FUNDER_DIR/funder-$index.json"
  [ -f "$key" ] || solana-keygen new --no-bip39-passphrase --silent -o "$key"
done

TARGET_LAMPORTS=$(python3 -c "print(int(float('$TARGET_SOL') * 1_000_000_000))")

log "deployer $DEPLOYER"
log "target   $TARGET_SOL SOL"

for round in $(seq 1 "$MAX_ROUNDS"); do
  current="$(balance_lamports "$DEPLOYER")"
  log "round $round: deployer holds $(python3 -c "print(f\"{$current/1e9:.4f}\")") SOL"
  if [ "$current" -ge "$TARGET_LAMPORTS" ]; then
    log "target reached"
    exit 0
  fi

  # Ask every faucet for the deployer directly, then for each funder in the pool.
  for rpc in "${FAUCETS[@]}"; do
    request_airdrop "$rpc" "$DEPLOYER" 2000000000 >/dev/null
    sleep 2
  done

  for index in $(seq 1 "$POOL_SIZE"); do
    key="$FUNDER_DIR/funder-$index.json"
    address="$(solana address -k "$key")"
    for rpc in "${FAUCETS[@]}"; do
      request_airdrop "$rpc" "$address" 2000000000 >/dev/null
      sleep 2
    done
  done

  sleep 6

  # Sweep every funder that received something, leaving enough for the transfer fee.
  for index in $(seq 1 "$POOL_SIZE"); do
    key="$FUNDER_DIR/funder-$index.json"
    address="$(solana address -k "$key")"
    held="$(balance_lamports "$address")"
    if [ "$held" -gt 20000 ]; then
      sweep=$((held - 15000))
      if solana transfer "$DEPLOYER" "$sweep" \
        --from "$key" --fee-payer "$key" --lamports \
        --allow-unfunded-recipient --no-wait \
        -u "${FAUCETS[0]}" >/dev/null 2>&1; then
        log "  swept $(python3 -c "print(f\"{$sweep/1e9:.4f}\")") SOL from funder-$index"
      fi
    fi
  done

  sleep "$ROUND_SLEEP"
done

final="$(balance_lamports "$DEPLOYER")"
log "stopped after $MAX_ROUNDS rounds with $(python3 -c "print(f\"{$final/1e9:.4f}\")") SOL"
exit 1

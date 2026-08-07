# shellcheck shell=sh
# Single source of truth for VINCT's pinned toolchain locations and endpoints.
# Source it, do not execute it:  . scripts/toolchain-env.sh
#
# The Solana CLI is pinned per-project under .toolchain/ so this repository never
# depends on, or disturbs, whatever release is globally active on the machine.

VINCT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export VINCT_ROOT

# Pinned versions. Changing any of these requires re-running scripts/source-lock.ts
# and updating docs/source-lock.md in the same commit.
export VINCT_SOLANA_VERSION="3.1.9"
export VINCT_ANCHOR_VERSION="1.0.2"
export VINCT_RUST_VERSION="1.89.0"
export VINCT_EPHEMERAL_VALIDATOR_VERSION="0.13.19"

export VINCT_SOLANA_HOME="$VINCT_ROOT/.toolchain/solana"
export VINCT_SOLANA_BIN="$VINCT_SOLANA_HOME/active_release/bin"
# Keep agave-install's bookkeeping inside the project so `agave-install update`
# run from here can never repoint the machine-wide installation.
export VINCT_SOLANA_INSTALL_CONFIG="$VINCT_SOLANA_HOME/config.yml"

if [ -d "$VINCT_SOLANA_BIN" ]; then
  case ":$PATH:" in
    *":$VINCT_SOLANA_BIN:"*) ;;
    *) PATH="$VINCT_SOLANA_BIN:$PATH"; export PATH ;;
  esac
fi

# Local MagicBlock stack. mb-stack defaults, restated so scripts and tests agree.
# Request flow: client -> query filtering service (6699) -> ER (7799) -> base (8899).
export VINCT_BASE_RPC="http://127.0.0.1:8899"
export VINCT_BASE_WS="ws://127.0.0.1:8900"
export VINCT_ER_RPC="http://127.0.0.1:7799"
export VINCT_ER_WS="ws://127.0.0.1:7800"
export VINCT_QFS_RPC="http://127.0.0.1:6699"
export VINCT_QFS_WS="ws://127.0.0.1:6700"

# Devnet. Never hardcode a regional ER endpoint; resolve it through the router.
export VINCT_DEVNET_BASE_RPC="https://rpc.magicblock.app/devnet"
export VINCT_DEVNET_ROUTER="https://devnet-router.magicblock.app/"
export VINCT_STATUS_API="https://status.magicblock.app/api/services"

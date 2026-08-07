#!/usr/bin/env bash
# Installs the project-pinned Solana CLI into .toolchain/ and verifies the pinned
# Rust and Anchor toolchains are present. Idempotent: re-running is a no-op once
# every pinned version already matches.
#
# The machine-wide Solana installation is deliberately left alone. agave-install
# is invoked with an explicit --config inside .toolchain/ so it cannot repoint
# ~/.config/solana/install/config.yml.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./toolchain-env.sh
. "$SCRIPT_DIR/toolchain-env.sh"

log() { printf '%s\n' "$*"; }

installed_solana_version() {
  [ -x "$VINCT_SOLANA_BIN/solana" ] || return 1
  "$VINCT_SOLANA_BIN/solana" --version 2>/dev/null | awk '{print $2}'
}

if [ "$(installed_solana_version || true)" = "$VINCT_SOLANA_VERSION" ]; then
  log "solana $VINCT_SOLANA_VERSION already pinned at $VINCT_SOLANA_HOME"
else
  installer=""
  if command -v agave-install >/dev/null 2>&1; then
    installer="$(command -v agave-install)"
  elif command -v solana-install >/dev/null 2>&1; then
    installer="$(command -v solana-install)"
  else
    log "ERROR: neither agave-install nor solana-install is on PATH."
    log "Install the Solana CLI once, then re-run this script."
    exit 1
  fi

  mkdir -p "$VINCT_SOLANA_HOME"
  log "Installing solana $VINCT_SOLANA_VERSION into $VINCT_SOLANA_HOME"
  "$installer" init \
    --config "$VINCT_SOLANA_INSTALL_CONFIG" \
    --data-dir "$VINCT_SOLANA_HOME" \
    --no-modify-path \
    "$VINCT_SOLANA_VERSION"
fi

actual_solana="$(installed_solana_version || true)"
if [ "$actual_solana" != "$VINCT_SOLANA_VERSION" ]; then
  log "ERROR: expected solana $VINCT_SOLANA_VERSION, found '${actual_solana:-none}'"
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  log "ERROR: rustup is required to honour rust-toolchain.toml"
  exit 1
fi
rustup toolchain install "$VINCT_RUST_VERSION" --profile minimal >/dev/null
rustup component add rustfmt clippy --toolchain "$VINCT_RUST_VERSION" >/dev/null

if command -v avm >/dev/null 2>&1; then
  if ! avm list 2>/dev/null | grep -q "^$VINCT_ANCHOR_VERSION[[:space:]]*(installed"; then
    log "Installing anchor $VINCT_ANCHOR_VERSION via avm"
    avm install "$VINCT_ANCHOR_VERSION"
  fi
else
  log "WARNING: avm not found. Anchor $VINCT_ANCHOR_VERSION must be installed manually."
fi

log ""
log "Pinned toolchain:"
log "  solana  $("$VINCT_SOLANA_BIN/solana" --version)"
log "  sbf     $("$VINCT_SOLANA_BIN/cargo-build-sbf" --version | tr '\n' ' ')"
log "  rustc   $(rustup run "$VINCT_RUST_VERSION" rustc --version)"
log "  anchor  $(anchor --version 2>/dev/null || echo 'not on PATH')"
log "  node    $(node --version 2>/dev/null || echo 'not on PATH')"
log "  pnpm    $(pnpm --version 2>/dev/null || echo 'not on PATH')"

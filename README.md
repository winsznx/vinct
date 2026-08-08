# VINCT

Binding mutual aid for protocols.

Protocols that depend on the same oracle, bridge, or library have no way to prepare for
its failure together. Each one writes a private runbook, and when the dependency breaks
they find out from Twitter and act alone.

VINCT lets those protocols ratify a covenant before the crisis, certify an incident
privately inside a Private Ephemeral Rollup, and coordinate their own bounded emergency
adapters through MagicBlock. The circle never receives admin authority over anyone.
Each protocol owns its adapter and the one narrow action it permits.

## Status

Phase 4 of 8. The two mechanisms the product depends on have both run on Devnet.

Magic Actions settlement (Phase 3): three protocol-owned adapters paused three markets
through one intent bundle, and a deliberately broken cohort produced
`COMMIT_WITHOUT_ACTIONS` rather than a partial application. One failing BaseAction removes
the whole cohort, confirmed on both a local stack and Devnet.

Sealed quorum (Phase 4): a member learns that their own submission was accepted and nothing
else. Not another member's decision, not how close the incident is to its threshold. That
holds because the state is split into a public core, a claim private to the member set, and
one ballot per member private to that member, with no account anywhere holding a live tally.

The architecture rests on a property of private ephemeral rollups that took an experiment to
establish: a permission gates *reading* an account, not touching it. Two members each mutated
an account neither could read, neither could read the other's ballot, and the program's
arithmetic over both was correct. See
[docs/privacy-boundary.md](docs/privacy-boundary.md), limitations included.

The full lifecycle run against the attested rollup is pending: that endpoint is still serving
a cached clone of an older build, and the freshness gate refuses to collect evidence from it.

There is no user interface yet; that is Phase 7. See
[docs/IMPLEMENTATION_GATES.md](docs/IMPLEMENTATION_GATES.md) for what each phase has to prove
before the next one starts.

## What the design rests on

An ER scheduling signature means the intent was accepted. It does not mean the base-layer
actions ran. Within one attempted base transaction the commit and its actions are atomic,
but when a BaseAction fails the committor may strip every BaseAction from that transaction
strategy and retry the remaining commit work. A later successful commit is therefore not
evidence that the originally scheduled actions executed.

So VINCT treats `COMMIT_WITHOUT_ACTIONS` as a first-class state, observes every expected
base-layer effect independently, and refuses to report `SETTLED` until the adapter
receipts, the target protocol states, and the final settlement receipt are all seen. A
missing action is never retried blindly; recovery takes a new operation ID and a new nonce.

## Repository

```
docs/          PRD, gates, source lock, decision log, claim ledger, privacy boundary, runbooks
programs/      vinct-core, vinct-adapter, and a mock protocol to act on
crates/        pure types, the executable reference model, program tests
packages/      TypeScript client, standalone verifier, canonical test vectors
scripts/       toolchain pinning, source lock, service status, the Phase 3 and 4 seam runners
tests/         cross-language parity and client/IDL account-order tests
probes/        compatibility and PER-visibility probes. Experiments, not product code
artifacts/     evidence: Devnet runs, benchmarks, leak scans, status captures
```

Every claim the project makes is in [docs/claim-ledger.json](docs/claim-ledger.json) with the
transactions, artifacts, and commands behind it, and its limitations written next to it.

## Getting set up

Requires `rustup`, `avm`, Node 22+, `pnpm`, and a Solana CLI installation to bootstrap
from. The project pins its own Solana release under `.toolchain/` and leaves whatever is
installed machine-wide alone.

```bash
bash scripts/bootstrap-toolchain.sh
pnpm install --frozen-lockfile
```

Verify the pinned combination:

```bash
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
anchor build
pnpm typecheck
pnpm lint
```

Run the local MagicBlock stack through a start-and-stop cycle:

```bash
pnpm stack:cycle
```

Capture live service and routing state:

```bash
pnpm check-magicblock-status
pnpm exec tsx scripts/probe-router.ts
pnpm source-lock
```

## Reproducing the Devnet proofs

Both runners need a funded Devnet deployer at `.toolchain/keys/devnet-deployer.json` and
resolve their rollup from live routing rather than from a configured endpoint.

```bash
pnpm exec tsx scripts/phase3-seam.ts             # Magic Actions cohort
pnpm exec tsx scripts/phase3-seam.ts --fail-one  # one adapter deliberately fails
pnpm exec tsx scripts/phase4-per.ts                  # private incident lifecycle
pnpm exec tsx scripts/per-visibility-experiment.ts  # does a permission gate reads or execution?
pnpm exec tsx scripts/await-fresh-runtime.ts        # wait for a rollup to pick up this build
```

The Phase 4 runner refuses to collect anything from a rollup that is not executing the build
in this checkout, and refuses to pass on a leak scan that had nothing to find. What goes
wrong on Devnet and what to do about it is in
[docs/runbooks/devnet-proof-runs.md](docs/runbooks/devnet-proof-runs.md).

## Versions

Exact versions, upstream commits, and the evidence behind each choice are in
[docs/source-lock.md](docs/source-lock.md), with the machine-readable companion at
`artifacts/source-lock/version-report.json`.

## Claims

[docs/claim-ledger.json](docs/claim-ledger.json) records every public claim with its
proof level, the commands that produced it, and its limitations. A claim never outruns
the evidence recorded next to it.

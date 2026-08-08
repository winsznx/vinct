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

Phase 8. The whole mechanism runs end to end on a local MagicBlock stack and on Solana Devnet.

Formation, a private incident, certification, settlement, and expiry all run in one sequence
with nothing chosen by the runner. Three protocols form a covenant and arm their own adapters
before any incident exists. An incident opens under it, collects a private claim and sealed
attestations inside the rollup, certifies in memory, scrubs, and returns to base. The
certificate is published permissionlessly from the released incident, and the Magic Action
cohort settles under the operation ID certification derived. Every effect is then read back off
the base layer.

The failure paths are the interesting half. An unregistered adapter signer and a capability
suspended after certification both produce `COMMIT_WITHOUT_ACTIONS`, with no market paused,
because one failing BaseAction removes the whole transaction strategy. Nothing partial was ever
observed.

An incident nobody answers settles itself. A crank requested on the rollup runs, does nothing
while the response window is open, and settles the incident at its deadline without anyone
acting.

Sealed quorum holds. A member learns that their own submission was accepted and nothing else.
Not another member's decision, not how close the incident is to its threshold. The state is
split into a public core, a claim private to the member set, and one ballot per member private
to that member, and no account anywhere holds a live tally.

That rests on a property of private ephemeral rollups that took an experiment to establish: a
permission gates reading an account, not touching it. Two members each mutated an account
neither could read, neither could read the other's ballot, and the program's arithmetic over
both was correct. See [docs/privacy-boundary.md](docs/privacy-boundary.md), limitations
included.

The web product reads a chain and holds nothing. Eight surfaces, no server, no session, no
database. The proof path takes an operation ID and re-derives it from the covenant's frozen
terms with an implementation that shares no code with the on-chain program, with no wallet and
no login.

Everything above runs on Solana Devnet too, against a real MagicBlock ephemeral rollup, with its
own artifact under `artifacts/devnet/`. The composition, both failure paths, the expiry crank,
and a cancellation that stopped a running task short of its iteration count.

One claim has no Devnet evidence for this build. Confidentiality needs an attested rollup, and
attestation and runtime freshness turn out to be independent: `devnet-us` executes this build and
answers no TDX quote, while `devnet-tee` answers a valid quote and executes a binary it cached
before this build existed. `pnpm exec tsx scripts/probe-runtimes.ts` prints the current state.
The sealed-quorum property therefore rests on the local stack and on the PER visibility
experiment.

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
crates/        pure types, the executable reference model, program tests, layout vectors
packages/      TypeScript client, settlement monitor, standalone verifier, test vectors
apps/web       the web product: observer, proof path, incident room, status
scripts/       toolchain pinning, source lock, and every phase runner
tests/         cross-language parity, account layouts, and the browser suite
probes/        compatibility and PER-visibility probes. Experiments, not product code
artifacts/     evidence: run records, benchmarks, leak scans, browser video
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

## Running the whole thing

Start the local MagicBlock stack, deploy the three programs, and run the sequence:

```bash
bash scripts/bootstrap-local.sh start
pnpm exec tsx scripts/phase5-composition.ts                  # the full mechanism
pnpm exec tsx scripts/phase5-composition.ts --fail-one       # one adapter cannot act
pnpm exec tsx scripts/phase5-composition.ts --suspend-one    # a protocol pulls out late
pnpm exec tsx scripts/phase6-expiry.ts                       # nobody answers; the crank settles it
pnpm exec tsx scripts/phase6-expiry.ts --cancel              # the opener stops the crank
```

Each writes a record under `artifacts/local-stack/`. Verify one independently, trusting the
run's addresses and none of its claims:

```bash
pnpm verify-operation artifacts/local-stack/phase5-composition-success.json
```

The web product, with a real chain behind it:

```bash
pnpm web                # dev server
pnpm proof:web          # compose an incident, build, then the browser suite with video
```

## Reproducing the Devnet proofs

Both runners need a funded Devnet deployer at `.toolchain/keys/devnet-deployer.json` and
resolve their rollup from live routing rather than from a configured endpoint. A public RPC
will not sustain a program deploy of this size; use a dedicated endpoint through
`VINCT_BASE_RPC`.

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

## Checking the work

```bash
pnpm audit-claims     # every ledger claim: stamped, reproducible, bounded, artifacts present
pnpm scan-artifacts   # no credential and no private material in anything committed
pnpm check-vectors    # committed vectors are what the Rust would generate today
pnpm verify-vectors   # the standalone verifier agrees with them, byte for byte
```

What went wrong and the gate each mistake left behind is in
[docs/audit-report.md](docs/audit-report.md).

## Versions

Exact versions, upstream commits, and the evidence behind each choice are in
[docs/source-lock.md](docs/source-lock.md), with the machine-readable companion at
`artifacts/source-lock/version-report.json`.

## Claims

[docs/claim-ledger.json](docs/claim-ledger.json) records every public claim with its
proof level, the commands that produced it, and its limitations. A claim never outruns
the evidence recorded next to it.

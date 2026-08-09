# Verification

How to check every claim this project makes, from a browser, a terminal, or the chain.

## Without installing anything

Open <https://vinct.timjosh507.workers.dev/proof> and paste an operation ID.

It reads the incident and its covenant from Devnet, re-derives the operation identity from the
covenant's own frozen terms using an implementation that shares no code with the on-chain
program, and confirms the certificate and every receipt carry that identity. Seventeen checks, no
wallet, no login.

Verification and delivery are shown apart. Verification says an operation ID is the honest
derivation of terms the members agreed to. Delivery says what landed. A cohort that was scheduled
and stripped has correctly bound receipts and no effects, so folding them together would let a
verified identity read as a completed settlement.

## From a terminal

```bash
pnpm verify-operation artifacts/devnet/phase5-composition-success.json
```

Reads the addresses from a run artifact and trusts none of its claims.

```bash
pnpm verify-vectors     # the standalone verifier agrees with Rust, byte for byte
pnpm check-vectors      # committed vectors are what the Rust would generate today
pnpm audit-claims       # every ledger claim: stamped, reproducible, bounded, artifacts exist
pnpm scan-artifacts     # no credential or private material in anything committed
```

## The full gate

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
anchor build --ignore-keys

pnpm typecheck
pnpm lint
pnpm test:ts
pnpm --filter @vinct/web build
pnpm exec playwright test
```

## Reproducing the protocol runs

```bash
bash scripts/bootstrap-local.sh start
pnpm exec tsx scripts/phase5-composition.ts                # settles
pnpm exec tsx scripts/phase5-composition.ts --fail-one     # one adapter cannot act
pnpm exec tsx scripts/phase5-composition.ts --suspend-one  # a protocol pulls out late
pnpm exec tsx scripts/phase6-expiry.ts                     # nobody answers
pnpm exec tsx scripts/phase6-expiry.ts --cancel            # the opener stops the crank
```

Point them at Devnet with `VINCT_BASE_RPC`, `VINCT_ER_RPC`, and a funded `VINCT_KEYPAIR`.

## The claim ledger

[claim-ledger.json](claim-ledger.json) records every public claim with its proof level, the
network it was verified on, the commands that produced it, its artifacts, and its limitations.
Its shape is fixed by [claim-ledger.schema.json](claim-ledger.schema.json).

A claim never outruns the evidence recorded beside it. `pnpm audit-claims` enforces that
mechanically, and it is a gate because one claim once pointed at a file that had never been
written.

## Proof levels

| Level | Meaning |
| --- | --- |
| 3 | pure model, or cross-language parity |
| 4 | program tests against real SBF objects in LiteSVM |
| 5 | observed on a local MagicBlock stack |
| 6 | observed on Solana Devnet |
| 7 | observed against attested TEE infrastructure |

---

**Next:** [claim-ledger.json](claim-ledger.json) for the claims these levels are attached to,
[audit-report.md](audit-report.md) for what the gates caught,
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for what no level covers, and
[runbooks/devnet-proof-runs.md](runbooks/devnet-proof-runs.md) to reproduce the Devnet runs.
[Back to the README](../README.md).

# VINCT

Binding mutual aid for protocols.

**Live app** <https://vinct.timjosh507.workers.dev> · **Demo** <https://vinct.timjosh507.workers.dev/demo> · **Verify** <https://vinct.timjosh507.workers.dev/proof>

Protocols that depend on the same oracle or bridge can agree in advance on exactly what each will
do in an emergency, decide privately whether it is happening, and act together. Nobody hands
anybody else authority.

## What problem this solves

Three lending protocols use the same price feed. It starts printing garbage. Each of them has a
runbook, each acts alone, they all find out from Twitter, and the slowest one absorbs the damage.

They could have agreed months earlier, and there was nothing to agree with.

A multisig is the wrong shape: it asks every protocol to hand authority to a group, and no
serious protocol will. A shared vote leaks, because any account holding a running tally can be
read by whoever can touch it, and knowing two of three have already approved is a tradeable fact.

## How it works

Each protocol arms one bounded action against its own contracts, before anything breaks: one
instruction, one account it may touch, one effect ceiling, one validity window.

When the dependency fails, a member opens an incident. The claim goes into an account inside a
private rollup that only the member set can read. Each member gets their own ballot account,
readable by exactly one key. They answer privately.

The program counts the answers in memory. If the threshold is met the incident earns a
certificate, and each protocol's own adapter reads it, checks it against the bounds that protocol
set, and acts or refuses.

Then every effect is read back off the base layer, one at a time, before anything is called
settled.

## What MagicBlock is doing that is load-bearing

| | |
| --- | --- |
| **Private Ephemeral Rollup** | Holds the claim and one ballot per member, each with its own permission. This is what makes a sealed quorum possible at all. |
| **Ephemeral Rollup** | Runs the delegated incident lifecycle and certification. |
| **Magic Actions** | The commit-linked cohort: three protocol adapters plus a settlement receipt in one intent. |
| **Cranks** | Expiry, so a stale incident cannot stay open waiting for a quorum that is not coming. |
| **Router** | Every rollup endpoint, resolved live. No regional endpoint is hardcoded anywhere. |

The design rests on a property established by experiment rather than assumed: **program execution
authorization and query visibility are separate**. A member can submit a transaction that makes
the program read and mutate accounts that member cannot read over RPC. That is what allows the
split-account model.

## What is private, and what is not

**Public:** that an incident exists, its threshold and window, its terminal outcome and final
counts, and all settlement evidence.

**Private to the member set:** the claim and its evidence.

**Private to one member:** that member's decision. Not the decision, not whether they answered,
not when, and not to the opener, the steward, or the other members either.

While an incident collects, **no account anywhere holds a count**. The tally exists only inside
certification, for the moment it runs.

Details, including what is deliberately not claimed, in
[docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md).

## What authority VINCT has

None.

There is no instruction anywhere that gives the circle, the steward, or any VINCT program the
ability to act on a member's contracts. A certificate is a published fact: it carries no
authority and grants none. An adapter reads it, revalidates it against bounds its own protocol
set before any incident existed, and decides.

A protocol can suspend its adapter at any moment, including after a certificate has been issued,
and the adapter still refuses.

## How settlement is verified

A scheduling signature means an intent was accepted. It does not mean anything happened: when a
base action fails, the committor can strip **every** action from that transaction and retry the
commit alone.

So `COMMIT_WITHOUT_ACTIONS` is a first-class state here, every effect is observed independently,
and a half-applied cohort blocks automated recovery outright.

Check it yourself at <https://vinct.timjosh507.workers.dev/proof>. Seventeen checks, no wallet: it re-derives the operation identity
from the covenant's own frozen terms with an implementation that shares no code with the on-chain
program.

| | |
| --- | --- |
| A settlement that landed | <https://vinct.timjosh507.workers.dev/proof/b259584f4498acbc356d1940865288b623f4049e155b73c574dad7d4d166af1a> |
| One that was scheduled and stripped | <https://vinct.timjosh507.workers.dev/proof/91e8cd15e8b57279ed6ce6ab95a9614348dc8d5041ff4d7a7b79e2bfcf4bd9a1> |

## Quick judge path

About 90 seconds, no wallet:

1. <https://vinct.timjosh507.workers.dev> : read the one sentence
2. **Explore live demo**: three protocols, one dependency, a real recorded incident
3. Step through the seven stages
4. Switch to **Nothing executed**: the scheduled cohort that did nothing, and VINCT saying so
5. **Verify this operation yourself**

Full script with what to say: [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md).

## Programs

Solana Devnet.

| Program | Address |
| --- | --- |
| `vinct_core` | `9BaZmGntudyAL5VodBWFCANchn7vx1Y7DNpXADbx6JcG` |
| `vinct_adapter` | `2BoSGgPxcpS2NcKGK9ygJdRfcfL6gYeDgh4QRGrujBM4` |
| `vinct_mock_protocol` | `BDUybXDdLCCbnCjthbs9NATmYZWTTKxCzqejyqyvzorS` |

## For reviewers

In this order:

1. This file
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the system without reading the codebase
3. [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md), trust boundaries and the failures that shaped them
4. [docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md), exactly what is hidden from whom
5. [docs/claim-ledger.json](docs/claim-ledger.json), every claim with its evidence and limits
6. [docs/decision-log.md](docs/decision-log.md), why each decision was made, with the evidence
7. `programs/`, starting with `vinct-core` then `vinct-adapter`
8. `crates/vinct-reference`, the executable model the programs are checked against

[docs/audit-report.md](docs/audit-report.md) lists what we got wrong and the gate each mistake
left behind. [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) is explicit about what is
still not proven.

## Local development

Needs `rustup`, `avm`, Node 22+, `pnpm`, and a Solana CLI to bootstrap from. The project pins
its own Solana release under `.toolchain/` and leaves the machine-wide one alone.

```bash
bash scripts/bootstrap-toolchain.sh
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.development.local
pnpm web                     # the app, against Devnet, on http://localhost:5173
```

The copy is not optional. A deployment reads the chain through `/rpc` on its own origin, which
is the Cloudflare Worker holding the upstream credential, and `vite` serves no such route. Skip
the copy and every read 404s while the pages still render, so the console reports an empty chain
rather than a missing endpoint. `.env.development.local` names a public Devnet endpoint directly,
and the dev server says so on screen if the file is missing.

The `.development` in that filename is load-bearing. Vite reads `.env.local` in every mode,
production builds included, so the same values parked there would quietly replace the Worker
proxy in a deployed bundle. A production build warns if `VITE_SOLANA_RPC` is set at all.

The whole mechanism, end to end, on a local MagicBlock stack:

```bash
bash scripts/bootstrap-local.sh start
pnpm exec tsx scripts/phase5-composition.ts                # settles
pnpm exec tsx scripts/phase5-composition.ts --suspend-one  # a protocol pulls out late
pnpm exec tsx scripts/phase6-expiry.ts                     # nobody answers; the crank settles it
```

## Tests

```bash
cargo test --workspace       # 323 Rust tests
pnpm test:ts                 # 77 TypeScript tests
pnpm exec playwright test    # browser, desktop and mobile
pnpm audit-claims            # 61 claims, each stamped and bounded
pnpm scan-artifacts          # no credential or private material committed
```

Everything in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Claims

[docs/claim-ledger.json](docs/claim-ledger.json) records every public claim with its proof level,
the network it was verified on, the commands that produced it, and its limitations. A claim never
outruns the evidence recorded beside it, and `pnpm audit-claims` enforces that mechanically.

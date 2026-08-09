# Submission

## One line

Protocols sharing a critical dependency ratify a private mutual-aid covenant, certify an
incident inside a private ephemeral rollup, and coordinate their own bounded adapters.

## What it does

Three lending protocols use the same oracle. It starts printing garbage. Today each one has a
private runbook, they all find out from Twitter, and each acts alone.

VINCT lets them agree in advance. Each protocol arms one narrow capability against its own
contracts: one instruction, one target, one effect ceiling, one validity window. When the
dependency breaks, they open an incident whose claim and ballots live in accounts inside a
private rollup, each permissioned to exactly one reader. The program counts the votes in memory.
If the threshold is met, the incident earns a certificate, and each protocol's own adapter
honours it or refuses.

The circle never receives authority over anyone. There is no key that can produce a certificate,
only an incident that reached its covenant's threshold.

## Why it is hard

Three things, and each one cost an experiment.

A member must not learn how another member voted. Not just the public: each other. That rules
out any shared account holding a tally, because a permission that lets a member interact with an
account lets them read it. The state is split instead: a public core, a claim private to the
member set, one ballot private to each member, and no running count anywhere. It works because
of a property of private ephemeral rollups we had to establish by experiment rather than assume,
that a permission gates reading an account and not touching it.

A protocol must not hand anyone admin authority to get this. So a capability commits to the
shape of an action rather than to a future transaction, and is armed before any incident exists.
A protocol can suspend it at any moment, including after a certificate has been issued, and the
adapter still refuses.

A scheduling signature is not a settlement. When a base action fails, the committor can strip
every action from that transaction and retry the commit alone, so a later successful commit
proves nothing about the actions. `COMMIT_WITHOUT_ACTIONS` is a first-class state here, every
effect is read back off the base layer independently, and a cohort that half-applied blocks
automated recovery outright.

## How MagicBlock is used

| Product | Used for |
| --- | --- |
| Private Ephemeral Rollup | The incident's claim and ballots, each permissioned to one reader, and the threshold counted in memory |
| Ephemeral Rollup | The delegated incident lifecycle and the certification transaction |
| Magic Actions | The commit-linked cohort: three protocol-owned adapter actions plus a settlement receipt |
| Cranks | Incident expiry, so a stale incident cannot stay open indefinitely |
| Router | Rollup endpoints resolved live, through `getDelegationStatus` in scripts and `getRoutes` in the app. One regional default exists as a first candidate; the endpoint used is whichever answers with the current build fingerprint, never one picked by hostname |

The TEE-backed rollup is chosen by asking every router-advertised endpoint for a TDX quote over
a fresh challenge, and taking the one that answers with a quote bound to it. No hostname or
region name is part of that decision.

## What runs

The whole sequence, live, on a local MagicBlock stack: formation, arming, a private incident,
certification, the scrub, release to base, a permissionless certificate, a Magic Action cohort,
and reconciliation from base-layer state. Plus the failure paths, which are the half worth
watching, and a crank that settles an unanswered incident with nobody acting.

All of it also runs on Solana Devnet against a real MagicBlock ephemeral rollup, with its own
artifacts under `artifacts/devnet/`.

## Verify it without trusting us

```bash
pnpm verify-operation artifacts/local-stack/phase5-composition-success.json
```

Seventeen checks. It reads the incident and the covenant off the chain, re-derives the operation
ID from the covenant's own frozen terms with an implementation sharing no code with the on-chain
program, and confirms the certificate and every receipt carry that ID. Delivery is reported
alongside and explicitly not folded into the verdict.

The same thing in a browser at `/proof?operation=<id>`, with no wallet and no login.

## What we did not prove

Confidentiality has no Devnet artifact for this build. Attestation and runtime freshness are
independent properties and no rollup currently has both: `devnet-us` executes this build and
answers no TDX quote, `devnet-tee` answers a valid quote and executes a binary it cached before
this build existed. The composition therefore ran on `devnet-us`, which proves the mechanism and
says nothing about an enclave. The sealed-quorum property rests on the local stack and on the
PER visibility experiment.

Attestation proves a genuine TDX quote bound to a fresh challenge. It does not compare MRTD or
RTMR against an expected workload, so it does not establish which code runs inside the enclave.

Nothing here establishes traffic-analysis resistance, or that an incident's existence is
concealed. Its existence is public by design. Its contents are not.

## Where to look

| | |
| --- | --- |
| Every public claim, with commands and limitations | `docs/claim-ledger.json` |
| What we got wrong and the gate each mistake left | `docs/audit-report.md` |
| 83 decisions, with the evidence behind each | `docs/decision-log.md` |
| Exactly what is and is not private | `docs/PRIVACY_MODEL.md` |
| Run records from every proof | `artifacts/` |

64 claims. Every one verified, stamped with a commit, reproducible by a named command,
carrying its artifacts, and carrying at least one stated limitation. `pnpm audit-claims` checks
that, and it is a gate because one claim once pointed at a file that had never been written.

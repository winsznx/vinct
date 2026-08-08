# The VINCT privacy boundary

What an incident hides, from whom, and on whose word.

Claims here are stated against runs that happened. The architecture experiment is
`artifacts/devnet/per-visibility-experiment-latest.json`. The lifecycle evidence will be
`artifacts/devnet/phase4-per-phase4-per-latest.json`; see [Status](#status) for what is
currently proven and what is waiting. Where a claim rests on something no run tested, it says
so.

## Sealed quorum

The property VINCT is built for: a member learns that their own submission was accepted and
nothing else. Not another member's decision, not another member's evidence, not how close the
incident is to its threshold.

That is not cosmetic. A member who can watch the count knows whether their vote is the
deciding one, which is exactly the position that invites coercion. A member who can read a
peer's ballot can retaliate for it.

It holds because of how the state is split, not because of care taken at each instruction.

| Account | Who may read it | What is in it |
| --- | --- | --- |
| `IncidentCore` | Anyone | Covenant, policy, threshold, deadline, status, member count |
| `IncidentClaim` | The incident's members | The responder's raw claim, notes, observation window |
| `MemberAttestation` | That one member | That member's decision, nonce, submission slot |
| a live tally | — | There isn't one |

There is no account that holds quorum progress while an incident is live. Certification is
handed every attestation at once and counts them in memory. A running total would have to
live somewhere, and anywhere it lived would be readable by whoever could read that account.
What is never stored cannot leak.

## Why this works: permissions gate reading, not touching

The first implementation put everything in one permissioned account and concluded that
co-member privacy was impossible on this platform. That was wrong, and it took an experiment
rather than more reasoning to find out.

The question nobody had answered: on a private rollup, must a wallet be inside an account's
permission to send a transaction that *mutates* it, or only to *read* it? The official
sealed-auction example does not settle it, because its auctioneer is a member of every bid's
permission and is the one who calls `end_auction`.

`probes/per-visibility-probe` answered it against the attested Devnet rollup. Three delegated
accounts: an aggregate whose only permission member is the aggregate PDA itself, which is off
the ed25519 curve and so is a key nobody holds, plus one ballot per member private to that
member. Both members then cast, in transactions that wrote their own ballot and incremented
the aggregate.

Both casts landed. Neither member could read the other's ballot. Neither could read the
aggregate. Nor could the wallet that had created and paid for all three. Nor could an
anonymous caller. Afterwards, opening the aggregate showed 1 approval and 1 rejection: the
program had been reading and writing an account no participant could see, and got it right.

So execution authorization and query authorization are separate concerns on a PER, and the
sealed-quorum property is reachable. See `docs/decision-log.md` D-0042 and D-0043.

One detail worth keeping. A refused read comes back as *no account*, not as an error. An
observer cannot distinguish "you may not see this" from "this does not exist".

## Why not commit-reveal

The obvious cryptographic answer is commitments plus a reveal round, and VINCT does not use
one. It would turn a k-of-n threshold into an n-of-n liveness dependency: certification would
wait on every member to open their commitment, so one offline or uncooperative member could
stall an emergency response indefinitely. For a mutual-aid covenant that is a worse failure
than the one it fixes. The PRD rules it out in §7.3 and the split-account model achieves the
same privacy without it.

Certification requires every attestation *account* to be passed, not every member to have
*acted*. A silent member's account exists, holds no decision, and contributes nothing.
`certification_does_not_wait_for_a_silent_member` is the test.

## The observer classes

Four, and they are genuinely different.

| Who | The core | The claim | A ballot that is theirs | A ballot that is not |
| --- | --- | --- | --- | --- |
| Anyone, no credential | readable | refused | refused | refused |
| An authenticated non-member | readable | refused | — | refused |
| A member | readable | readable | readable | refused |
| The opening responder | readable | readable | — | refused |

Authentication is not authorization, and the runs prove that rather than assuming it. A
non-member completes the rollup's challenge-sign-login flow successfully and holds a valid
session token. The permission still refuses. A key that can prove who it is has proven
nothing about what it may see.

## What is protected, and how that is checked

Six private field classes: the raw claim, the responder's notes, the responder's observation
window, and each member's decision, nonce, and submission slot. Each carries its own canary
through the Phase 4 run.

Two things must be true for a clean scan to mean anything, and both are checked.

The canaries were present. A leak scan over a marker that was never written passes for the
wrong reason, so the run reads each private account through the principal entitled to it,
before the scrub, and requires every field class to be found. That is
`leakScan.positive_control`.

The canaries did not escape. Ten surfaces are then scanned: the core, claim, and every
attestation on the base layer; every base transaction; every rollup transaction read back
with no credential; the claim, the ballots, and the permission accounts read with no
credential; the artifact the run is about to write; and the run's own terminal output.

Two surfaces are not covered and are named rather than quietly omitted. Browser
`localStorage`, `sessionStorage`, and `IndexedDB` cannot be scanned by a Node script because
no browser is involved; Phase 7 covers them. Third-party telemetry is not scanned because
this repository sends none, which is a property of the code rather than a result of the run.

## What is still visible

### Existence and activity

An observer can see that an incident exists, which covenant and policy it belongs to, when it
closes, and how many members it has. That is `IncidentCore`, and it is public on purpose: it
is the view the PRD gives observers (§24.3).

They can also see that private accounts exist at derivable addresses and that transactions
touch them. Ballot accounts are created for every member when the incident opens, before
anyone votes, so their existence says nothing about who has responded. But an observer
watching the base layer sees accounts created, delegated to a named validator, and later
undelegated, along with the timing of each.

The PRD anticipates this (§25, "TEE metadata leak"): no content appears, existence may remain
visible. VINCT makes no traffic-analysis resistance claim.

### One bit from certification

`certify_incident` is permissionless and succeeds only when the incident is terminal, so a
caller learns whether it has certified. That bit is the public `status` field anyway.

Everything else about certification is uniform. Every non-terminal refusal is
`IncidentNotTerminal` whatever the reason, so a caller cannot distinguish "not enough
approvals yet" from "already too many rejections". An incident that cannot reach its
threshold waits for its deadline rather than terminating early, so the moment a blocking
rejection lands is not observable either.

### What the TEE attestation establishes

`scripts/phase4-per.ts` selects its rollup by asking every router-advertised endpoint for a
TDX quote over a fresh 64-byte challenge and verifying that the quote's report data is that
exact challenge. In the recorded runs, one of four endpoints answered. No region name,
country code, or hostname takes part in that decision.

That establishes a genuine quote, bound to this challenge, from hardware Intel's chain
vouches for.

It does not establish which code is running inside the enclave. `verifyTeeRpcIntegrity` does
not compare MRTD, RTMR, or configuration values against an expected workload allowlist, and
VINCT does not currently maintain one. Until it does, VINCT must not claim the attestation
proves workload identity. It also does not establish traffic-analysis resistance, and it does
not hide the existence of an incident.

## Who may change who can see

The claim's permission decides who reads the evidence, so the two instructions that write it
require the opening responder to sign.

The permission program will not accept an external key as a permission's authority: the
permissioned PDA signs for itself. That protects the permission from the permission program's
side and says nothing about who may ask `vinct_core` to make the call. The first
implementation asked for nothing, which meant any funded wallet could add itself to a live
incident's readers. See `docs/decision-log.md` D-0039.

Delegation is opener-signed for the same reason in a different direction: the caller picks the
validator, so a stranger who could delegate someone else's incident would be choosing which
rollup that responder's private material lands on (D-0041).

An attestation's permission takes no member list at all. The program reads the single member
off the account, so there is no argument a caller could pass that would put a second reader on
someone's ballot.

Closing a permission has no signer, on purpose. It is gated on the scrub, and a scrubbed
account has nothing left to expose. Requiring a signature would let a responder who dislikes
an outcome strand the account inside the rollup. Same reasoning as the permissionless scrub
and the permissionless certification.

## The zeroization gate

Nothing leaves the private runtime while protected material is present. Four doors, one lock:

- `commit_incident` copies bytes to the base layer
- `release_incident` does the same and undelegates
- `close_claim_permission` makes the claim readable again on that rollup
- `close_attestation_permission` does the same for one ballot

The gate runs per account. A release that scrubbed the claim and two of three ballots is
still refused, which `one_unscrubbed_ballot_blocks_the_release` asserts, because a gate that
only checked the accounts named in the context would publish the third member's decision.

The gate reads bytes, not flags. `protected_fields_are_zero` walks the claim buffer, the notes
buffer, the observation window, and each attestation's decision, nonce, and slot, and only
then does `may_leave_the_private_runtime` check that `private_fields_zeroized` is set. A
program that set the flag without scrubbing is caught by the first check. The ordering is the
point.

The exit paths hold their accounts as `UncheckedAccount` and read them by hand. A typed Anchor
`Account` is written back when the instruction ends, which lands after `commit_and_undelegate`
has already taken the account into the intent, and Devnet rejects that as
`ExternalAccountDataModified`. See D-0029.

## Freshness

No Phase 4 artifact is collected from a rollup that is not running the current build.

Phase 3 lost an afternoon to an `InvalidActionCount` that was correct in every account it
named: the rollup was executing a clone of the program taken before an upgrade, and the only
tell was that the Anchor error's line number belonged to the previous build (D-0030).

`programs/vinct-core/build.rs` hashes every source file in the crate into a fingerprint the
`build_info` instruction returns. Before anything is proven, the run compares three values:
the fingerprint computed from this checkout, what the base-layer deployment answers, and what
the selected rollup answers. All three must agree. Anything else is recorded as stale, the run
tries the next attested endpoint, and if none is fresh it writes `BLOCKED_STALE_RUNTIME` and
collects nothing.

The rollup's *account* clone of the program data stays current across an upgrade; its
executable cache does not, and nothing VINCT can send clears it (D-0040). The gate is
therefore most necessary on repeat runs, not least.

## What a member is told

The uniform acknowledgement is a real property, not a UI convention. A submission either
succeeds or names why it was refused, and every reason is about the submitter:
`NotAnEligibleMember`, `MemberQuarantined`, `NonceNotIncreasing`, `IncidentExpired`,
`IncidentNotCollecting`. None varies with anyone else's decision or with how close the
incident is to its threshold. A successful submission returns no data at all, which
`a_submission_returns_no_data` asserts.

## Status

| Rung | State |
| --- | --- |
| Architecture experiment on the attested rollup | proven, `artifacts/devnet/per-visibility-experiment-latest.json` |
| Program-level sealed quorum and zeroization | proven, 27 tests in `crates/vinct-program-tests/tests/privacy.rs` |
| Client and IDL account-order parity | proven, `tests/program/incident-client-parity.test.ts` |
| Full lifecycle and read matrix on the local stack | proven, `artifacts/local-stack/phase4-local-lifecycle.json` |
| Full lifecycle on the TEE-backed rollup | blocked: the attested endpoint is serving a cached clone of an older build, and the freshness gate refuses to collect from it |

The local run is worth being precise about. The local MagicBlock stack runs the same
query-filtering service with the same challenge-sign-login flow, so it exercises the read
matrix for real: alpha reads alpha's ballot, and alpha, beta, the opener, an outsider, and an
anonymous caller are each refused beta's. It has no enclave and no attestation, so it says the
permission model behaves as documented on the reference implementation. It does not say a
confidential runtime is holding the line. That is what the Devnet run is for.

## Reproducing this

```
pnpm exec tsx scripts/per-visibility-experiment.ts   # the architecture question
pnpm exec tsx scripts/phase4-per.ts                  # the full lifecycle
cargo test -p vinct-program-tests --test privacy     # the program half, no network
```

The Devnet runners need a funded deployer at `.toolchain/keys/devnet-deployer.json` and pick
their rollup from live routing. `VINCT_INCIDENT_ID` selects a fresh incident; one that has
already reached a terminal state cannot be rerun, by design.

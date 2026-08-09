# Adversarial audit

Phase 8. What was checked, what it found, and what remains untrue or unproven.

The useful part of an audit is the list of things it found, so that comes first.

## Findings

Every one of these passed the gates that existed at the time. Each is fixed, and each left a
gate behind so the same class cannot return silently.

### 1. A claim pointed at an artifact that was never written

`tee-attestation-is-discovered-live` named `artifacts/devnet/phase4-per-phase4-per-latest.json`.
No such file has ever existed. The run stopped at the freshness gate and wrote a differently
named file, which does contain the evidence the claim describes.

The claim was true. That is the least interesting thing about it. A ledger row exists so
somebody else can check it, and a row naming a file that does not exist is unfalsifiable, which
is the exact property a claim ledger is meant to remove.

Fixed by correcting the reference and recording the run's real stopping point as a limitation.
Gated by `scripts/audit-claims.ts`, which now refuses a claim without a reachable source commit,
artifacts that exist on disk, a reproducing command, and a stated limitation. See D-0070.

### 2. The web application had never been typechecked

`tsconfig.web.json` extended the base config. `exclude` is inherited rather than merged with
`include`, and the base excluded `apps`, so the project resolved to zero files and `tsc`
reported success while checking nothing.

Found by deliberately breaking a field name and observing that the gate stayed green. Fixing it
immediately surfaced three real errors that had been shipping. See D-0067.

The habit is the finding: break something on purpose and confirm the gate fails. A check that
has never been seen to fail is not evidence.

### 3. The observer reported iteration exhaustion as a successful cancellation

`watchCancellation` established removal by watching the iteration count hold still. A task that
ran out of iterations also stops, so the monitor reported `REMOVAL_OBSERVED` for a cancel that
had done nothing. The artifact said the cancel worked. The chain said the task ran to
completion.

Fixed by taking the requested iteration count and refusing to call exhaustion removal. See
D-0061.

### 4. A cancel request that could never work

VINCT scheduled the expiry crank as the payer and cancelled it as the opener. The scheduler
takes the signer of a schedule request as the task's authority and silently drops a cancel from
anyone else, so both transactions succeeded and the task ran all 32 iterations. Fixed by
requiring the opener to sign both. See D-0060.

### 5. The committed vectors were stale

`ActionTemplateV1` gained six fields and `gen-vectors` was never re-run. The vectors kept
describing the old layout, the TypeScript encoder kept matching them, and the parity test kept
passing. Both sides agreed with each other and neither agreed with the program.

It surfaced only because a later phase added a vector and forced regeneration. That is luck, not
detection. `scripts/check-vectors.sh` now makes a stale vector a failing build. See D-0055.

### 6. The verifier reported delivery it had not checked

Its receipt checks were named "settled the derived operation" while what they checked was the
operation binding. Run against a deliberately failed cohort it printed `PASS alpha settled` for
a cohort where nothing had executed: the receipts existed, because they are created before
scheduling, and carried the right operation ID.

Identity and delivery are separate now, and delivery is explicitly reported rather than
asserted. See D-0058.

### 7. Two authorization holes in the incident lifecycle

A permission instruction with no signer check let any wallet add itself as a reader of a live
incident. A delegation instruction never checked its signer against the account being delegated,
so a stranger could choose which rollup another incident's private material landed on. See
D-0039 and D-0041.

### 8. Certification could be handed a ballot set the incident never had

`initialize_attestation` creates a ballot for any key, so an opener could create four, open with
three, and hand certification a different three. Fixed by computing the member-set commitment on
chain at open and reconstructing the ballot set at certification rather than trusting what is
supplied. See D-0044.

### 9. A capability could not be armed before the incident it was for

The armed commitment included a receipt address seeded by an operation ID that does not exist
until certification, so arming required an incident to already exist. The product invariant is
the opposite: protocols authorize the shape and limits of mutual aid before the crisis. Fixed
with a versioned action template that commits to roles rather than derived addresses. See D-0048
and D-0050.

### 10. A decoder that lied

After three fields were added to `IncidentCore`, a run reported two approvals as fifty and zero
rejections as 239, and printed PASS. Two faults: a drifted decoder, and a verdict that only read
the status. Every evidence-producing decoder is now pinned to a vector generated from the
program's own Rust struct, and fails closed on discriminator, length, and version. See D-0051
and D-0052.

### 11. A credential written into an artifact

The Devnet runs record the endpoints they used, so `redactEndpoint` was applied to the
`endpoints` field. The first run wrote the key into the artifact anyway: the runners print their
own configuration at the top and `say()` keeps every line for the transcript, which nobody had
thought to redact.

Redaction happens where text is retained now, not at each place somebody remembered. The key
never reached git, verified with `git log --all -S` rather than assumed, and the untracked
artifacts were regenerated.

`scripts/scan-artifacts.ts` is the gate, and it was verified by planting a file with a provider
key, incident canary text, and a recorded decision, watching it fail, and watching it pass once
removed. See D-0071.

### 12. A relative RPC URL that failed with no error at all

The deployment points the app at its own `/rpc` proxy so a paid credential stays server-side.
Every route rendered, no console error appeared, and nothing worked: zero requests were made.

`Connection` parses its endpoint eagerly and throws `Invalid URL` on a relative path, before any
request exists. The throw was caught by the caller's own error handling, which then had nothing
to report, so the page sat in its idle state looking like it had simply not been asked.

Worth recording for the signature rather than the fix: no error, no network activity, and a UI
that looks like it is waiting for input. See D-0082.

### 13. Two controls that stayed visible and stopped working

A sticky nav that wraps to two rows on a phone and covers what the reader scrolled to, and a
flex form whose label overflowed and swallowed every click aimed at the button beside it. Worse
than a broken layout, because neither a screenshot nor a human skim catches them. Found by the
mobile browser project's actionability checks. See D-0068.

## Privacy audit

| Check | Result |
| --- | --- |
| Canary claim text in any committed artifact | none |
| Decision words next to a member in any artifact | none |
| Private submission data or nonces in artifacts | none |
| `msg!` logging of claims, decisions, or ballots | none |
| Events carrying private fields | none |
| Browser storage across every route | one key, holding a public covenant address |
| Off-origin requests from the web app | none |
| Analytics globals or CDN scripts | none |

Both exit paths from the private runtime are gated by `may_leave_the_private_runtime`, which
checks the zeroization flag and independently checks that the protected bytes are actually zero.
The bytes check is the stronger one: a flag set without a scrub would pass the requirement as
written and fail here.

The leak scan has a positive control. It requires every canary to be present inside the
permission before the scrub, so a scan that found nothing because it was looking in the wrong
place fails instead of passing.

## Cold code audit

| Check | Result |
| --- | --- |
| `unwrap`, `expect`, `panic!`, `todo!` in program paths | none |
| `unsafe` | forbidden by attribute in all three programs and both library crates |
| Unchecked arithmetic in programs | none; checked or saturating throughout |
| `TODO`, `FIXME`, `XXX`, `HACK` anywhere in tracked source | none |
| Type suppression: `as any`, `@ts-ignore`, `@ts-expect-error` | none |
| Secrets, keypairs, or tokens in tracked files | none |
| AI attribution or co-author trailers in commit history | none |
| Credentials or private material in any committed artifact | none, and `pnpm scan-artifacts` gates it |
| Key material in the deployed bundle | none: zero 64-byte arrays, zero credential patterns |
| Secret reachable from the browser | none: the RPC credential is a Worker secret |

`#![forbid(unsafe_code)]` was added to the three programs during this audit. It was already on
`vinct-types` and `vinct-reference`. A rule the build cannot check is a rule that holds until
somebody is in a hurry.

## Claims audit

64 claims, every one verified, stamped with a reachable commit, reproducible by a named command,
carrying its artifacts, and carrying at least one stated limitation.

| Network | Claims |
| --- | --- |
| none (pure model, cross-language parity) | 15 |
| litesvm (program and authority constraints) | 11 |
| localnet | 9 |
| local MagicBlock stack | 13 |
| devnet | 16 |

Run `pnpm audit-claims` to check them.

## The deployed product

Everything the protocol proves is now operable. A member authenticates to the private rollup with
their own wallet, reads the claim and their own ballot, and submits an answer the wallet signed.
A steward convenes; each protocol ratifies and arms with its own key.

No secret key exists in the application. `pnpm scan-bundle` fetches what a browser actually
receives and finds zero 64-byte arrays and zero credential patterns. The upstream RPC credential
is a Cloudflare Worker secret and never reaches the page.

Writing is gated on runtime freshness rather than warned about. A rollup serving a cached
executable would accept a signature for logic nobody deployed, so a mismatch disables submission.

The Cloudflare boundary holds by construction: the Worker cannot sign, stores nothing, and never
sees private incident material, which travels from the browser straight to MagicBlock. If it
vanished the app still works against any RPC a reader names with `?base=`.

## What is not proven

Stated plainly, because a claim ledger is only as good as its refusals.

The confidentiality claim has no Devnet artifact for this build, and cannot yet have one.
Attestation and runtime freshness are independent properties, and `pnpm exec tsx
scripts/probe-runtimes.ts` shows no rollup currently has both: `devnet-us` executes this build
and answers no TDX quote, `devnet-tee` answers a valid quote and executes a binary it cached
before this build existed, and the other two never cloned the program at all. The composition
therefore ran on `devnet-us`, which proves the mechanism and says nothing about an enclave. The
sealed-quorum property rests on the local stack and on the earlier PER visibility experiment.

A public Devnet RPC cannot deploy a program this size. Three attempts failed three different
ways for one cause, each leaving an orphaned buffer that was reclaimed in full. That is an
operational finding rather than an unproven claim, and it is written up in
`docs/runbooks/devnet-proof-runs.md`.

Attestation establishes a genuine TDX quote bound to a fresh challenge, from hardware Intel's
chain vouches for. It does not compare MRTD or RTMR values against an expected workload, so it
does not establish which code runs inside that enclave.

Nothing here establishes traffic-analysis resistance, or that an incident's existence is
concealed. The existence of an incident is public by design; its contents are not.

The crank's requested iteration count is not a delivered one. A task requesting two iterations
at a one-second interval produced one observed execution in twenty seconds. The design does not
depend on the answer, because the expiry handler is a no-op before the deadline and idempotent
after it, but nothing in this repository may assume a scheduler honours a cadence.

Registration of a scheduled task is inferred from an observed execution, because the validator
exposes no task registry. The inference is one-way: a registered task that has not yet fired
reads as `REQUESTED`, never the reverse.

The browser suite runs on Chromium in two viewports. None of the properties it checks is engine
specific, but it has not been run on another engine.

## Verdict

CONDITIONAL PASS.

Every mechanism the product depends on is proven twice: on a local MagicBlock stack and on
Solana Devnet against a real ephemeral rollup, each with its own artifact. That covers formation
and arming, the private incident, certification, the Magic Action cohort, both failure paths,
the expiry crank, and cancellation.

The condition is one claim. Confidentiality has no Devnet evidence for this build, because the
only attested rollup is executing a binary it cached before this build existed and the freshness
gate refuses to collect from it. That is external and outside this repository's control, and the
claim it supports is proven on the local stack and by the PER visibility experiment.

The condition is not that anything is believed to work and untested. It is that one claim
already proven on two runtimes has not been proven on a third, and the reason is a cache in
somebody else's infrastructure.

---

**Next:** [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the unproven set stated plainly,
[claim-ledger.json](claim-ledger.json) for every claim with its evidence,
[VERIFICATION.md](VERIFICATION.md) to run the gates yourself, and
[decision-log.md](decision-log.md) for the reasoning behind each correction.
[Back to the README](../README.md).

# VINCT Implementation Gates

Every phase ends with executable evidence. Do not start the next phase until the current phase passes.

# Phase 0: Source and compatibility lock

Scope:

- install current MagicBlock and Solana skills
- record skill commits
- record MagicBlock engine examples commit
- inspect current Magic Actions, private counter, and crank examples
- choose one compatible Rust, Solana, Anchor, SDK, Node, and TypeScript stack
- create the local repository structure
- commit lockfiles locally
- create status and version capture scripts

Required evidence:

- `docs/source-lock.md`
- `artifacts/source-lock/version-report.json`
- compatibility probe compiles with PER access control, Magic Actions, and crank dependencies
- pinned local stack starts and stops cleanly
- live status API response captured or an explicit unavailable artifact retained

Tests:

- `cargo check`
- TypeScript typecheck
- local stack health
- source-lock script is idempotent

Adversarial cases:

- incompatible Anchor feature
- stale copied example
- unavailable npm package
- status API unavailable
- local stack child process remains after shutdown

Completion gate:

- exact versions and SHAs are recorded
- one minimal program compiles with the selected feature line
- no dependency is labelled latest without a live check

Stop boundary:

- no product logic
- no GitHub repository creation unless a live source or deployment requirement makes it necessary

# Phase 1: Reference model and canonical commitments

Scope:

- `vinct-types`
- `vinct-reference`
- covenant, policy, incident, attestation, quarantine, certificate, settlement, and recovery models
- canonical Borsh digests
- generated TypeScript vectors
- zeroization model

Required evidence:

- deterministic vectors
- exhaustive three-member state-space report
- property-test report
- Rust and TypeScript hash parity

Tests:

- all edge cases in the PRD
- every one-byte and order mutation
- replay
- threshold boundaries
- quarantine
- expiry
- settlement classifications

Adversarial cases:

- sorted account metas
- duplicate action index
- trailing bytes
- stale epoch
- cross-cluster replay

Completion gate:

- production code can import the reference types
- no independent expected-value implementation exists

Stop boundary:

- no Anchor instruction beyond scaffolding

# Phase 2: Sovereign adapters and reference protocols

Scope:

- three mock protocol states
- reference sovereign adapter
- protocol-owned capability lifecycle
- adapter receipt
- local action execution without Magic Actions

Required evidence:

- each protocol authority installs and arms only its own adapter
- circle or steward cannot arm it
- exact bounded pause works
- arbitrary CPI fails
- duplicate operation fails

Tests:

- owner, signer, PDA, discriminator, account order, data hash, effect limit, expiry, version, nonce
- stale or suspended adapter
- wrong target protocol
- malicious extra writable account
- compute benchmark

Completion gate:

- three adapters update three independent protocol states through their exact bounded path
- CU numbers retained

Stop boundary:

- no PER and no Magic Actions

# Phase 3: Magic Actions seam

Scope:

- minimal delegated state
- `MagicIntentBundleBuilder`
- three adapter BaseActions
- final settlement receipt action
- PDA escrow authority
- observation and reconciliation harness

Required evidence:

- ER signature
- attempted base transaction
- measured per-action CU
- measured total CU, account count, and serialized size
- all adapter receipts and target effects on success
- one deliberate failure
- exact committor retry/removal behavior captured

Tests:

- wrong meta
- missing signer seeds
- insufficient escrow
- per-action CU exhaustion
- one failed action in cohort
- duplicate operation
- delayed observation

Completion gate:

- the settlement classifier matches actual target-environment behavior
- `SETTLED` occurs only with all effects
- `COMMIT_WITHOUT_ACTIONS` is detected if produced
- no naive retry exists

Stop boundary:

- no product UI
- if this gate fails, revise the product before continuing

# Phase 4: PER private incident lifecycle

Scope:

- delegated incident account
- ER-local `EphemeralPermission`
- signed client authentication
- private claim
- sealed attestations
- no live exact quorum
- zeroization gate
- terminal scrub

Required evidence:

- authorized member can read and submit
- unauthorized wallet cannot read protected state
- another member cannot query a member's decision
- public logs and base state contain no private fixture marker
- unsanitized commit and undelegation fail
- scrubbed terminal account can commit

Tests:

- permission authority loss
- revoked member
- unauthorized observer
- client storage and telemetry scan
- TEE verification and expected workload allowlist, if implemented

Completion gate:

- TEE-backed Devnet PER proves the declared observer boundary
- privacy limitations documented

Stop boundary:

- no polished UI

# Phase 5: Full covenant and incident composition

Scope:

- covenant formation
- ratification
- adapter set
- incident snapshot
- private certification
- Magic Action settlement
- settlement monitor
- recovery registry

Required evidence:

- one complete successful lifecycle
- one complete failure lifecycle
- independent verifier output
- base and ER signatures retained
- claim ledger updated

Tests:

- stale covenant
- unarmed adapter
- member replacement
- quarantine
- certificate expiry
- wrong bundle
- router mismatch
- service timeout

Completion gate:

- dominant mechanism runs end to end
- result matches reference model
- no optional feature is required

Stop boundary:

- no extension work

# Phase 6: Crank expiry and operational recovery

Scope:

- collision-resistant task ID
- finite expiry schedule
- observed registration
- idempotent expiry handler
- observed cancellation
- manual expiry fallback
- undelegation after permission close

Required evidence:

- request accepted
- scheduler registration observed
- iteration observed
- incident expired
- cancellation and removal observed
- duplicate iteration harmless

Tests:

- task collision
- wrong authority cancel
- account unavailable
- delayed iteration
- repeated iteration
- undelegation while task active

Completion gate:

- stale incident cannot remain active indefinitely
- user-facing states distinguish scheduler lifecycle

# Phase 7: Web product and proof path

Scope:

- formation
- adapter inspection
- private incident room
- observer
- settlement
- proof page
- resettable demo
- network status

Required evidence:

- Playwright video
- no-wallet proof path
- private route access tests
- deep-link reload
- outage state
- standalone verifier parity

Tests:

- unauthorized route
- no private localStorage
- no telemetry leak
- settlement state transitions
- mobile and desktop core path

Completion gate:

- judge understands the result in under thirty seconds
- proof path is under two minutes

# Phase 8: Adversarial audit and submission

Local pre-push gate:

- run every CI-equivalent command locally
- run secret scan locally
- validate deployment configuration locally
- inspect git status and diff
- confirm no AI co-author trailers exist in commit messages
- confirm README and public prose follow the root writing/voice guidance files when present


Scope:

- cold code audit
- sponsor-integration audit
- target-chain evidence audit
- privacy audit
- claims audit
- README
- demo script
- submission copy

Required evidence:

- audit report
- claim ledger with no unsupported claims
- final source lock
- final transactions and program IDs
- tagged release
- green CI
- completed and resettable artifacts

Completion gate:

- PASS, CONDITIONAL PASS, or FAIL with exact evidence
- submission proceeds only on PASS or explicitly accepted CONDITIONAL PASS

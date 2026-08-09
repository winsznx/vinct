# Known limitations

Separated by kind, because "we have not built it" and "the platform will not let us" and "this is
a deliberate boundary" are three different things and collapsing them would be misleading.

## Product boundaries

**Devnet only.** No mainnet deployment, and none intended for this build. `CLAUDE.md` forbids
mainnet-specific complexity.

**The protocols are mock protocols.** `vinct_mock_protocol` is a market with one pausable flag.
It exists to be acted on and is not a lending protocol. A real integration means a real protocol
writing its own adapter against its own contracts, which is the design's point and also work
nobody has done yet.

**One action category.** `ActionCategoryV1` has a single variant, `PauseNewBorrowing`. The
template model generalises; the catalogue does not yet.

**Opening an incident is not in the browser.** Formation, ratification, arming, and the sealed
member response are. Opening additionally needs the delegation and permission setup for the whole
incident family, which is scripted rather than wired into a page.

**Recovery is a client-side artifact.** `proposeRecovery` builds a governed proposal and refuses
the cases that must be refused. Nothing on chain enforces that a proposal existed before a
replacement cohort is scheduled. What the chain does enforce is that the new operation ID is
different, which is what makes a duplicate effect impossible.

## Platform and operational limitations

**No rollup is currently both fresh and attested.** Attestation and runtime freshness turn out to
be independent properties. `devnet-us` executes the current build and answers no TDX quote;
`devnet-tee` answers a valid quote and executes a binary it cached before this build existed.

Consequence: the confidentiality claim has no Devnet artifact for the current build. It rests on
the local MagicBlock stack and on the PER visibility experiment. Everything else, including the
full composition, both failure paths, and the expiry crank, has Devnet evidence.

`pnpm exec tsx scripts/probe-runtimes.ts` prints the live state, so this is one command to
re-check rather than a claim to take on faith.

**A rollup's executable cache does not clear on a base-layer upgrade.** Nothing VINCT can send
evicts it. The app refuses writes against a stale runtime rather than warning, which is correct
and also means a stale rollup makes the live member flow unavailable until it catches over.

**The scheduler's iteration count is a request, not a delivery.** A task asking for two
iterations at a one-second interval produced one observed execution in twenty seconds. The design
does not depend on the answer, because the expiry handler is a no-op before the deadline and
idempotent after it.

**Task registration is inferred.** The validator exposes no task registry, so registration is
established from an observed execution. The inference is one-way: a registered task that has not
fired reads as `REQUESTED`, never the reverse.

**A public RPC cannot deploy a program this size,** and paid tiers commonly decline
`getProgramAccounts`. Both are worked around and both are written up in
`docs/runbooks/devnet-proof-runs.md` and `docs/DEPLOYMENT.md`.

## Claims deliberately not made

TEE attestation proves a genuine TDX quote bound to a fresh challenge. It does **not** compare
MRTD or RTMR against an expected workload allowlist, so it does not establish which code runs
inside the enclave.

No claim of constant-time behaviour, traffic-analysis resistance, or concealment of an incident's
existence. An incident's existence is public by design.

The threat model does not cover a compromised protocol authority key, a malicious rollup operator
with a fabricated attestation, or collusion among a threshold of members.

## Testing boundaries

Router mismatch and service timeout are proven against stubs rather than a degraded live service,
which is the honest rung for a failure you cannot ask a provider to produce on demand.

The browser suite runs on Chromium in two viewports. None of the properties it checks is engine
specific, but it has not been run on another engine.

The classification sweep is exhaustive at two actions, which is the smallest width where
`PartialObservation` is reachable. Larger cohorts exercise the same branches.

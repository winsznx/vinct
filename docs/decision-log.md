# VINCT Decision Log

Each entry records a decision that changed the plan, plus the evidence behind it. Entries
are append-only. Superseding an entry means adding a new one that says so.

---

## Phase 0 — 2026-08-07

### D-0001 Pin the Solana CLI per project instead of switching the machine default

The globally installed Solana CLI is 2.1.11, whose `cargo-build-sbf` ships platform tools
v1.43 with rustc 1.79.0. That cannot build `anchor-lang 1.0.2`. The Solana skill's
compatibility matrix pairs Anchor 1.0.x with Solana CLI 3.x and platform tools v1.52.

Rather than repoint the machine, `agave-install init` was run with an explicit
`--data-dir .toolchain/solana` and `--config .toolchain/solana/config.yml`, so the
project carries its own 3.1.9 and the developer's global 2.1.11 is untouched.
`scripts/toolchain-env.sh` prepends the pinned `bin` directory to `PATH`, and every
script sources it.

3.1.9 was chosen because it is the release the MagicBlock skill's known-good snapshot
names, and because Agave 3.1.9 still ships `solana-test-validator`, which the local
MagicBlock stack wraps.

Evidence: `cargo-build-sbf --version` on both installs; `cargo build-sbf` producing
`magicblock_compat_probe.so` under 3.1.9.

Side note recorded for honesty: the first `agave-install init` invocation used the
default config path and rewrote `~/.config/solana/install/config.yml` to point at the
project directory. It was restored to `2.1.11` and the machine-wide `active_release`
symlink was never touched. `scripts/bootstrap-toolchain.sh` now always passes `--config`
so the failure mode cannot recur.

### D-0002 Anchor line: `anchor-lang 1.0.2` with the SDK's `anchor` feature

Environment note: `avm install 1.0.2` also makes 1.0.2 the machine-wide default, replacing
the 0.32.1 that was current. `Anchor.toml` pins `anchor_version = "1.0.2"`, so this
project is unaffected by whichever default is active. Anyone who needs 0.32.1 back for
another repository can run `avm use 0.32.1`; `scripts/bootstrap-toolchain.sh` installs
1.0.2 if missing but does not force it as the default on re-runs.


Every MagicBlock engine example VINCT depends on — `magic-actions/anchor`,
`private-counter/anchor`, `crank-counter/anchor`, `delegation-actions/anchor`,
`sealed-auction/anchor` — pins `anchor-lang 1.0.2` and `ephemeral-rollups-sdk 0.16.2`.
Anchor CLI 1.0.2 was installed with `avm` to match.

The alternative feature, `anchor-compat`, targets Anchor `>=0.28,<1.0`. Building the
probe's real source with `anchor-compat` against `anchor-lang 1.0.2` produced 71 compile
errors.

Worth recording: a crate that only *declares* `anchor-compat` alongside `anchor-lang
1.0.2` still passes `cargo check`, because the compat feature pulls its own
`anchor-lang-compat`. The mismatch only surfaces when the macros meet Anchor 1.x types.
Feature choices in this project must be validated against real macro use.

### D-0003 Pin the whole `anchor-*` crate set to 1.0.2 in `Cargo.lock`

Default resolution took `anchor-attribute-*`, `anchor-derive-*`, and `anchor-syn` to
`1.1.2` while `anchor-lang` stayed at `1.0.2`. All three upstream example lockfiles
resolve the whole set at `1.0.2`, and the Solana skill's matrix warns that Anchor 1.1.2
tightened its inter-crate pins.

`cargo update --precise` brought the set back to `1.0.2` and `anchor-lang-idl` to `0.1.2`,
matching the upstream lockfiles exactly. `cargo check`, `cargo build-sbf`, and
`anchor build` all pass afterwards.

### D-0004 TypeScript SDK stays at 0.14.3 while the Rust SDK is 0.16.2

npm `latest` for `@magicblock-labs/ephemeral-rollups-sdk` is `0.16.2`, matching the Rust
crate. The engine examples pin `0.14.3`. The two published `.d.ts` trees were compared
file by file: identical, except `0.16.2` exports one extra constant
(`TOKEN_2022_PROGRAM_ID`). In particular the `access-control` and `magic-router` surfaces
are byte-identical.

With no functional difference in the surfaces VINCT uses, the version MagicBlock actually
runs its tests against wins. Recorded as an open question: a runtime difference in
permission or intent encoding at Phase 3 or 4 would force a bump.

`@coral-xyz/anchor` stays at `0.32.1` even though the program is built with Anchor 1.0.2.
The skill states this pairing explicitly, every example uses it, and `0.32.1` is npm
`latest` for that package.

### D-0005 Solana client stack is `@solana/web3.js` v1

The PRD requires one client stack with no mixing of `@solana/kit` and `@solana/web3.js`.
Every engine example and `magic-router-sdk` build on web3.js v1, so that is the stack.
`@solana/kit` is not a dependency. Any future kit interop stays behind `packages/client`.

### D-0006 Compatibility probe lives in `probes/`, not `programs/`

The PRD's repository layout (§29) does not name a `probes/` directory. The probe is a real
Anchor program but is not VINCT product code, and Phase 0's stop boundary forbids product
logic. Putting it in `programs/` would leave a throwaway program sitting next to
`vinct-core`, `vinct-adapter`, and `vinct-mock-protocol` from Phase 2 onward.

`probes/magicblock-compat-probe` is a member of the root Cargo workspace and is registered
in `Anchor.toml`. `programs/` and `crates/` stay empty until Phase 1 and Phase 2.

This is an addition to the PRD's layout, not a replacement of it.

### D-0007 The local stack needs a funded ER validator identity

`mb-stack` from `@magicblock-labs/ephemeral-validator@0.13.19` will not start: the
ephemeral validator exits with
`ValidatorInsufficientlyFunded(mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev, 5)`. The
account dump shipped inside the package funds that identity with `53432154` lamports
(0.0534 SOL); the validator requires 5 SOL. The upstream `test-locally.sh` harness has no
airdrop step, so this is not something the examples work around either.

`scripts/bootstrap-local.sh` re-declares the account from
`scripts/fixtures/local-er-validator-identity.json` — the packaged dump with lamports
raised to 100 SOL. Extra `mb-stack` arguments are forwarded to `solana-test-validator` and
applied last, so the re-declaration wins. The fixture contains no key material.

Result: start in 5s, `getHealth` verified independently on base, ER, and QFS, clean stop,
zero surviving processes.

### D-0008 Three SDK call sites do not transfer verbatim from the examples

Recorded because later phases will be tempted to copy them.

1. `CpiContext::new` in `anchor-lang 1.0.2` takes a `Pubkey`, not an `AccountInfo`. The
   skill's `delegation.md` snippet passes `to_account_info()` and does not compile;
   `private-counter`'s `.key()` does.
2. `ScheduleCrankCpi` and `CancelCrankCpi` take `&'a AccountInfo<'a>`. `AccountInfo` is
   invariant in its lifetime, so references built from `to_account_info()` inside a
   handler cannot satisfy it. They work from `ctx.remaining_accounts`, which is already
   `&'info [AccountInfo<'info>]`. The probe demonstrates both that path and the raw
   `MagicBlockInstruction::ScheduleTask` bincode encoding the crank example uses. Phase 6
   picks one.
3. `#[action]` appends `escrow_auth` as a non-mutable `UncheckedAccount`, so a Magic
   Action target cannot `init` its own accounts. Action target accounts must exist on base
   before scheduling. This constrains the settlement receipt and adapter receipt design in
   Phase 3: their PDAs have to be created ahead of the action, or created by a different
   payer inside the action.

### D-0009 Router `getDelegationStatus` does not obviously carry the ER endpoint

The PRD (§10, §18.2) and `CLAUDE.md` both instruct: resolve `getDelegationStatus` and use
the returned `fqdn`. Two pieces of evidence do not support that as stated.

- In `@magicblock-labs/ephemeral-rollups-sdk` `0.14.3` **and** `0.16.2`,
  `ConnectionMagicRouter.getDelegationStatus` is typed
  `Promise<{ isDelegated: boolean }>`. `getClosestValidator` is the method typed with an
  optional `fqdn`.
- Live against `https://devnet-router.magicblock.app/`, `getDelegationStatus` for an
  undelegated account returned exactly `{"isDelegated": false}`.

The implementation returns the router's raw `result`, so a delegated account may well
carry more fields — this has not been observed either way. The router's `getRoutes` method
does return `identity` and `fqdn` for all four devnet endpoints.

No correction is being made to the PRD yet, because the delegated-account case is
untested. Phase 3 must run `scripts/probe-router.ts --account <delegated pubkey>` and
either confirm the PRD or propose the smallest correction. Until then, nothing in this
repository may assume `getDelegationStatus` alone resolves an endpoint, and no regional
endpoint is hardcoded.

### D-0010 `tee/rpc_router` was DOWN on devnet at lock time

The 2026-08-07T16:27:57Z status capture shows `devnet-tee-as.magicblock.app` with `er`,
`pricing_oracle`, and `vrf_oracle` operational and `rpc_router` DOWN. Phase 4's TEE-backed
PER work depends on that region. Re-capture before any PER rehearsal and do not treat this
snapshot as current.

Also recorded: the status API keys the devnet TEE server as
`devnet-tee-as.magicblock.app` while the router advertises `https://devnet-tee.magicblock.app/`.
Different strings. Do not treat them as interchangeable.

### D-0011 One clippy allow, scoped to the probe crate

`cargo clippy -- -D warnings` fails on eight `clippy::diverging_sub_expression` warnings,
every one of which points at the `#[program]` attribute — Anchor 1.0.2's generated
dispatch code, not code written here. `#![allow(clippy::diverging_sub_expression)]` is
declared in the probe crate only, with the reason inline, so a genuine diverging
sub-expression in VINCT's own programs will still fail the gate.

No type errors were suppressed. There is no `unsafe`, no `unwrap`, and no `expect` in the
probe.

---

## Phase 1 — 2026-08-07

### D-0012 The operation ID derives from the registered template, not the concrete bundle

PRD section 12.4 derives `operation_id` from `action_bundle_hash`. PRD section 12.3 puts
`operation_id` inside `ActionBundleV1`. Neither value can be computed first.

The cycle closes a second time through the accounts. Receipt PDAs are seeded by the
operation ID (`["adapter_receipt", operation_id, adapter]` and `["settlement", operation_id]`
in PRD section 9), and those addresses appear in the bundle's account metas, which feed the
bundle hash.

Two ways out were considered.

1. Drop `operation_id` from `ActionBundleV1` and keep the PRD's derivation. Rejected: the
   receipt-address cycle survives, because the bundle would still have to name accounts
   whose addresses depend on the operation ID.
2. Derive `operation_id` from an operation-independent input instead. Taken.

The chosen derivation is:

```text
operation_id = sha256(
  sha256("VINCT_OPERATION_V1")
  || cluster_genesis_hash
  || covenant
  || circle_epoch_le64
  || incident_id_le64
  || policy_id
  || member_set_hash
  || action_bundle_template_hash
  || certificate_nonce_le64
)
```

`action_bundle_template_hash` is the policy's commitment to the *registered* action
templates, which a protocol authority reviews and signs when it arms its adapter. It is
fixed before any incident opens, so it introduces no cycle. `ActionBundleV1` keeps its
`operation_id` field exactly as PRD section 12.3 specifies.

Nothing the PRD's security invariants require is lost. Section 20.9 asks that a
certificate be cluster-, covenant-, epoch-, incident-, policy-, bundle-, and nonce-bound.
Seven of those are inside the operation ID directly. Binding to the *concrete* per-incident
bundle moves one level up: `CertificateV1.action_bundle_hash` carries it, and PRD section
14's adapter validation order checks the certificate's bundle hash and the operation ID
independently. An attacker who substitutes a concrete bundle changes its hash and fails
`CertificateRefusal::ActionBundleMismatch`.

Templates are the natural place for this binding anyway. A protocol that re-arms with
different bounds produces a different template hash, so every operation issued afterwards
has a different identity, which is the property that mattered.

Accepted as implementation evidence on 21 regression tests in
`crates/vinct-reference/tests/operation_binding.rs`: the derivation is acyclic and
computable before any concrete bundle exists, it is deterministic, every one of its eight
inputs is load-bearing and collision-free against the others, a receipt-address change
moves the bundle hash without moving the operation ID, a substituted concrete bundle is
refused by certificate validation, and replay across incidents, epochs, policies, clusters,
and consumed operations all fail. The TypeScript verifier reproduces the derivation
independently.

PRD sections 12.3 and 12.4 are superseded on this point. `docs/architecture-manifest.yaml`
records the corrected derivation.

### D-0013 A quarantined member's rejection keeps counting

A property test over covenants of two to eight members produced this counterexample: six
members, threshold two, rejection ceiling one, with two approvals and two rejections. The
incident evaluates to `RejectedByThreshold`. Quarantining one of the two objectors dropped
the rejection count to one, which no longer breached the ceiling, and the incident became
`Certified`.

Whoever holds the quarantine authority could therefore erase objections until the ceiling
stopped blocking, and push through an action the covenant had already refused. PRD section
21's threat table requires the test "quarantine cannot certify incident", and PRD section
16 ends with "a suspected compromise must never make automatic execution easier". Both were
violated.

Preserving `required_approvals` unchanged, which the model already did, is not sufficient.
The threshold is only one of the two gates; the rejection ceiling is the other, and
quarantine was lowering it.

The corrected rule is asymmetric on purpose:

- A quarantined member's **approval** is discarded. A possibly-compromised key must not
  authorise an action.
- A quarantined member's **rejection** still counts toward the ceiling. An objection cast
  while the member was trusted is a signal not to act, and honouring it is the fail-safe
  direction.
- A **superseded** record never counts either way. The member replaced it themselves, while
  trusted.

Implemented as `IncidentState::binding_attestation`, which is the effective record widened
by exactly the quarantine-invalidated case, plus `objecting_members`, which evaluates the
ceiling over every role-permitted member rather than only the currently eligible ones.

`Tally::rejections` can now exceed `Tally::eligible`. That is recorded on the field.

Quarantine can still make certification impossible, which is the intended direction:
eligible members shrink, so `max_reachable_approvals` shrinks with them.

Covered by `quarantining_dissenters_can_never_unblock_a_certification` and
`quarantine_never_reduces_the_rejection_count`, both exhaustive over the three-member space,
and by the `quarantine_never_helps_certification` property over two to eight members.

### D-0014 Canonical addresses are a plain 32-byte newtype

`vinct-types` must hash identically inside an Anchor program, in a host test, and in the
vector generator that feeds the TypeScript verifier. Depending on `solana-program` for
`Pubkey` would pull a runtime into the reference model and tie it to one Solana crate line.

`Address([u8; 32])` is Borsh-encoded as 32 raw bytes, which is byte-identical to `Pubkey`'s
encoding, so programs convert at their boundary and no wire format changes.

### D-0015 Account roles replace addresses for operation-derived template slots

Phase 0 established that `#[action]` injects `escrow_auth` as a non-mutable
`UncheckedAccount`, so a Magic Action target cannot create its own accounts. Receipt
accounts must therefore exist before an action is scheduled, and their addresses depend on
the operation ID.

A registered template cannot name them. Instead each slot declares an `AccountRoleV1`:
`Fixed`, `AdapterReceipt`, `SettlementReceipt`, or `Certificate`. A `Fixed` slot carries a
concrete address and must not be zero; a derived slot carries `Address::ZERO` and must not
carry anything else. Both rules are enforced by `TemplateAccountMetaV1::validate`.

This is Phase 0's preferred option A, and it is stronger than pinning a hash of a supplied
address: the adapter re-derives the expected PDA from the operation ID and compares, so a
substituted receipt account fails on the derivation rather than on a hash the attacker also
controls the input to.

None of the rejected properties are weakened. Idempotency still comes from the operation ID,
operation binding from the certificate, independent verification from the concrete bundle
hash, protocol sovereignty from the protocol-signed template, and settlement reconciliation
from observing each receipt PDA at its derived address.

### D-0016 Rejecting an out-of-order member set rather than sorting it

`MemberSetV1::new` imposes ascending address order when a set is constructed, so two clients
that agree on membership always agree on the hash. `MemberSetV1::validate`, which runs on
decode, **rejects** an out-of-order set instead of sorting it.

Normalising on decode would let a tampered encoding be repaired into a valid one. The same
reasoning applies to duplicates: a duplicate member is rejected, not deduplicated, because a
caller that submitted one is wrong about who the members are.

Account metas are covered by neither rule. They are never sorted anywhere, and
`sorting_account_metas_changes_the_digest` asserts that a sort is visible as a different
hash.

---

## Phase 2 — 2026-08-07

### D-0017 A protocol registers an adapter *signer*, never an adapter program

A market's `set_adapter` stores one `Pubkey` and `pause_new_borrowing` requires that exact
key to sign. The key is `["adapter-signer", capability]` under the adapter program, so only
that program, executing that capability, can produce it.

Registering a program ID instead would have been weaker in two ways. Every capability under
one adapter program would share the same trust, so protocol alpha's covenant participation
would implicitly authorise protocol beta's capability against alpha's market. And the
protocol would be trusting a program's whole instruction surface rather than one derived
authority.

The market therefore trusts a key, not a codebase. `one_protocols_adapter_cannot_pause_another_protocols_market`
and `the_target_protocol_independently_refuses_a_repeated_operation` cover it.

### D-0018 Adapter receipts are seeded by operation and capability

PRD section 9 gives the receipt PDA as `["adapter_receipt", operation_id, adapter]`, where
"adapter" is ambiguous between the adapter program and the capability. It is the capability.

Three protocols share one adapter program in the reference build, so seeding by program
would give them one shared receipt per operation and the first execution would block the
other two. Seeding by capability gives each protocol its own durable, independently
observable receipt, which is also what the reconciler needs in order to say which of the
three effects landed.

### D-0019 Splitting the certificate checks between the adapter and the bundle builder

PRD section 14 lists nineteen adapter validations, one of which is "action-bundle hash".
An adapter cannot perform that one. The concrete bundle spans all three protocols' actions
and an adapter can see only its own; it has no way to recompute the other two.

The split:

- The adapter enforces everything about its own action: certificate owner, cluster,
  covenant, epoch, policy, member set, expiry, operation identity, armed state, target
  program, discriminator, the exact ordered account metas, the exact instruction data, the
  effect bound, prior consumption, and its own protocol state.
- The concrete bundle hash is written onto the certificate by whoever built the bundle, and
  is independently recomputable by anyone from the registered templates plus the operation
  ID. The standalone verifier does exactly that.

The adapter still asserts the certificate *names* a bundle and carries at least one
approval, so a zeroed or empty certificate authorises nothing. Claiming to verify the whole
bundle would have been claiming a guarantee the adapter cannot provide.

### D-0020 The adapter refuses trailing accounts

Found by the `adding_an_extra_writable_account_is_refused` adversarial test, which initially
failed: Anchor moves any account beyond the declared context into `remaining_accounts` and
ignores it, so an appended writable account was accepted.

It was inert. The adapter never reads `remaining_accounts` and builds its CPI account list
explicitly, so the extra account could not be written by anything. It is refused anyway,
with `UnexpectedAccounts`: the ordered-meta commitment covers only the declared accounts, so
tolerating extras would mean a protocol authority signed off on a shorter account list than
the transaction actually carries. It also removes a class of future surprise if anyone later
adds `remaining_accounts` handling.

### D-0021 A failed CPI leaves no receipt and consumes no nonce

The receipt write and the capability's consumption record both happen *after*
`invoke_signed` returns. An adapter whose target CPI fails leaves the receipt unwritten and
the capability nonce unchanged, so the operation stays executable once the underlying
problem is fixed.

This matters for Phase 3. A reconciler that found a receipt for an effect that never
happened would classify a failure as success. `a_failing_adapter_still_leaves_no_partial_effect`
covers both halves: nothing is written on failure, and the same operation succeeds
afterwards.

### D-0022 Program keypairs live outside the repository

`anchor keys sync` adopted the generated keypairs and the resulting program IDs are
committed in `declare_id!` and `Anchor.toml`. The keypairs themselves are backed up to
`.toolchain/program-keys/`, which is gitignored, and are never committed.

A program keypair is only needed for the initial deploy; upgrades run through a separate
upgrade authority. Committing them would put a deploy credential in a public repository for
no benefit, and losing them costs nothing that matters here because the deployed IDs on
Devnet are the evidence and this repository records them.

### D-0023 Test fixtures compute slot windows from the live clock

LiteSVM starts at slot 435,888,000, a realistic mainnet-scale value. The first pass at the
Phase 2 fixtures used absolute constants (`valid_from_slot: 0`, `expires_at_slot: 500_000`),
which put every capability and certificate window in the past and made every execution fail
with `CertificateExpired`.

Fixtures now derive their windows from `Clock::slot`, which is also what production clients
will have to do. A slot number is only meaningful relative to now.

---

## Phase 3 — 2026-08-07

### D-0024 Router `getDelegationStatus` does carry the ER endpoint, for a delegated account

D-0009 recorded that `getDelegationStatus` returned only `{isDelegated: false}` and that the
PRD's routing instruction was therefore unconfirmed. With a genuinely delegated account on
Devnet, the same method returns:

```
{delegationRecord, fqdn, isDelegated}
```

and the resolver took the `getDelegationStatus.fqdn` path to `https://devnet-as.magicblock.app/`.

The PRD was right and the Phase 0 observation was simply made against an undelegated
account, where there is no endpoint to report. D-0009 is resolved in the PRD's favour.

`packages/client/src/routing.ts` still keeps its fallback chain — `fqdn`, then the router's
`getRoutes` table matched against the delegation record's validator identity, then an
explicitly configured endpoint — and records which source answered. The local stack has no
router at all, so the `configured` path is load-bearing rather than defensive.

### D-0025 The delegated account is written before the intent is built, never after

The first Devnet scheduling attempt failed with `ExternalAccountDataModified`. The handler
was setting `operation.scheduled` after `commit_and_undelegate` had already taken the
account into the intent.

The write moved ahead of the builder, followed by an explicit `exit` so the change is
serialized before the commit captures it. That is the correct order on its own merits: the
committed bytes that land on base must already say the cohort was scheduled, otherwise the
account would arrive claiming it never was.

### D-0026 The adapter must tolerate accounts the Magic Actions dispatcher appends

D-0020 hardened the adapter to refuse any account beyond its declared context. On the local
stack that turned out to break Magic Actions entirely: every scheduled action failed with
`UnexpectedAccounts` (0x1791), the committor stripped all four BaseActions, and the cohort
landed as `COMMIT_WITHOUT_ACTIONS` with nothing delivered.

The dispatcher legitimately supplies accounts of its own when invoking a target. D-0020's
reasoning was that a protocol authority should not sign off on a shorter account list than
the transaction carries, but that property is delivered elsewhere and more directly:
`ordered_account_metas_hash` commits to the declared six, the handler never reads
`remaining_accounts`, and the CPI account list is built explicitly from pinned capability
fields. An appended account is inert by construction.

The refusal is removed. The adversarial test changed from `adding_an_extra_writable_account_is_refused`
to `an_extra_account_is_inert`, which is the stronger assertion anyway: it appends beta's
market to alpha's action and proves beta's market is left untouched while alpha's is paused.

D-0020 is superseded on this point.

### D-0027 One failing BaseAction removes the whole cohort

The Phase 3 kill-gate question, answered from observation rather than documentation.

Protocol gamma's market was deliberately left without a registered adapter signer, so its
CPI failed with `NoAdapterRegistered` (0x1770) at instruction 6 of the attempted base
transaction. Alpha's and beta's actions were well-formed and would have succeeded.

The committor logged:

```
Patched intent: 2. error was: User supplied actions are ill-formed:
Error processing Instruction 6: custom program error: 0x1770
```

and retried the commit alone. Final base state: the scrubbed checkpoint committed and
undelegated, zero adapter receipts, zero target effects, settlement receipt not finalized.

Three consequences for the product.

All four BaseActions shared one transaction strategy. That is inferred rather than read —
the committor does not expose its grouping — but all four disappearing together is strong
evidence, and it is the answer the architecture manifest's open question was waiting for.

`PARTIAL_OBSERVATION` did not occur. The cohort behaved atomically at the strategy level,
which is what the product thesis needs: three protocols either all pause or none do.

`COMMIT_WITHOUT_ACTIONS` is real. It was observed three times, twice from a genuine action
failure and once from VINCT's own bug. An implementation that read the successful commit as
proof of settlement would have reported `SETTLED` for an operation in which nothing
happened, on all three occasions.

Evidence: `artifacts/local-stack/committor-behaviour.json` and the raw committor log
alongside it.

Scope: this is the local committor. The Devnet committor is a separate deployment and no
Devnet claim rests on this observation.

### D-0028 The local stack does not ship the committor program

`mb-test-validator` from `@magicblock-labs/ephemeral-validator@0.13.19` preloads eight
MagicBlock programs. `ComtrB2KEaWgXsW1dhr1xYL4Ht4Bjj3gXnnL6KMdABq`, the committor, is not
among them, and the package ships no dump of it.

The failure mode is quiet: the stack starts healthy, every service passes `getHealth`, ER
transactions succeed, and only intent execution fails, with
`FailedToPrepareBufferAccounts(... ProgramAccountNotFound ...)` buried in the ER log. From
the client's side it simply looks like nothing ever settles.

`scripts/bootstrap-local.sh` now dumps the program from Devnet on first use and preloads it
through `mb-stack`'s passthrough `--bpf-program`. The dump lives in `.toolchain/` and is not
committed, since it is MagicBlock's binary rather than ours.

This is a gap in the packaged local stack, not in VINCT.

### D-0029 The delegated account is held untyped and serialized by hand

Devnet rejected the scheduling instruction with `ExternalAccountDataModified` even after
D-0025 moved the state write ahead of the intent builder. The local stack had accepted the
same code.

The remaining write was Anchor's, not mine. A typed `Account<'info, T>` is written back
automatically when the instruction ends, and that happens after `commit_and_undelegate` has
already taken the account into the intent. The local ER tolerated it; Devnet did not.

`ScheduleSettlementCohort` now holds the operation as an `UncheckedAccount`, decoded and
re-encoded by hand through `SettlementOperation::load` and `::store`, with explicit owner
and discriminator checks so nothing a typed account would have verified is skipped. The
operation ID moved into the instruction arguments so the PDA seeds can still be constrained
without reading the account first.

This is the pattern `magicblock-engine-examples/crank-counter/anchor` documents on its own
context: "using UncheckedAccount to avoid Anchor re-serializing stale data after CPI". The
comment is easy to read as a nicety. It is not.

### D-0030 An ephemeral rollup serves a cached clone of an upgraded program

After the base-layer upgrade succeeded, the Asia ER kept executing the previous binary. The
symptom was a plausible-looking application error rather than anything that named staleness:
the old code read the new instruction data under the old argument layout, took the first two
bytes of the operation ID as `adapter_action_count`, and rejected it as
`InvalidActionCount`.

What settled it was the line number. The Anchor error pointed at a line that matched the
previous build, not the one on disk. Reading the operation account confirmed every value the
check tested was correct, so the failing code could not have been the code that was
deployed.

Delegating to the Europe validator instead routed to an ER with no cached clone, and the
same transaction succeeded immediately.

Two operational consequences. A program upgrade is not visible to an ER that has already
cloned it, so a deployment plan cannot assume base and ER agree. And an error surfaced by a
stale clone can look like a legitimate application error, which makes the Anchor line number
a load-bearing diagnostic rather than noise.

Recorded as an open question: how a cached clone is refreshed, or how long it persists, is
not established. Routing to a different validator is a workaround, not an answer.

### D-0031 Devnet confirms the local committor's cohort behaviour

Both Phase 3 paths now have Devnet evidence, and it matches the local stack exactly.

Success, ER signature `5GNFqCWagRWAGYQRYfVrDa9RjtStJtXjEcsmDuQhT2VDPty1n5fhZ3vFCaca3TPV8yNYhincksAco8ygRvpyHk2d`:
three protocol markets paused, three adapter receipts written, settlement receipt finalized,
operation account committed and undelegated. `ALL_ACTIONS_APPLIED`, every effect read back
from base-layer account state.

Deliberate failure, ER signature `2kqX3ewrFdwSQ4echtCorotg1PtAghvXBH5ieR8s1HmB9BvjhGxUcQFUHzRbbFPVgA2EnK4KSPJJYA1NL2PZjDi1`:
gamma's market left without a registered adapter signer. Zero adapters applied, settlement
not finalized, checkpoint committed. `COMMIT_WITHOUT_ACTIONS`.

The finding of D-0027 therefore holds on Devnet and not only locally: one failing BaseAction
removes the whole cohort. Alpha and beta were well-formed and still did not run.

Measured on the successful Devnet run: 61,428 CU for the ER scheduling transaction, 848
serialized bytes, 21 accounts, 280,000 CU declared across the four actions, and 19.2 seconds
from intent acceptance to every base-layer effect being observable.

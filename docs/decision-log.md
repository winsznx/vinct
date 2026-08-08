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

### D-0032 A rollup's TEE status is discovered, not configured

Phase 4 needs a TEE-backed rollup, and the obvious way to get one is to write down the
endpoint that has TEE in its name. Phase 3 already showed where that leads: the Europe
validator worked once, and hardcoding it would have baked a workaround into the product.

The router advertises four Devnet routes and none of them says which is attested. The status
API names a `tee` region, but its server FQDN (`devnet-tee-as.magicblock.app`) is not the one
the router advertises (`devnet-tee.magicblock.app`), so correlating them means matching
hostname fragments, which is guessing with extra steps.

The discriminator that actually works is the thing itself. `verifyTeeRpcIntegrity` asks an
endpoint for a TDX quote over a fresh 64-byte challenge and verifies the quote's report data
is that exact challenge. `scripts/phase4-per.ts` runs it against every route the router
currently advertises. In the recorded run, one of four answered. No hostname, region name, or
country code takes part in the decision.

Precise about what this establishes: a genuine quote, bound to this challenge, from hardware
Intel's chain vouches for. It does not compare MRTD or RTMR against an expected workload, so
it does not prove which code runs inside the enclave. VINCT does not maintain such an
allowlist yet and does not claim the check stands in for one.

### D-0033 A build fingerprint turns the stale-clone hazard into a check

D-0030 diagnosed a stale ER program clone from an Anchor line number. That worked once and is
not a procedure.

`programs/vinct-core/build.rs` hashes every `.rs` file in the crate, sorted, with paths taken
relative to the source root so a checkout elsewhere produces the same value. The digest is
compiled in as `VINCT_BUILD_FINGERPRINT` and returned by a `build_info` instruction through
both `set_return_data` and a log line.

Before any Phase 4 artifact is collected, three values are compared: the fingerprint computed
from the checkout, what base answers, and what the selected rollup answers. All three must
agree. A mismatch is classified as `STALE_ER`, `STALE_BASE`, or `UNDETERMINED`, the run moves
to the next attested endpoint, and if none is fresh it writes `BLOCKED_STALE_RUNTIME` and
collects nothing.

`UNDETERMINED` is deliberately not a pass. A runtime that fails to answer `build_info` has not
told us it is current.

The check is a simulation rather than a transaction. A freshness gate that costs SOL is one
that gets skipped when a run is in a hurry.

### D-0034 Permission members get no visibility flags

The permission program's member flags govern who can see whose transaction logs, messages,
balances, and signatures. Membership alone is what lets a wallet interact with a private
account.

The first implementation granted every member `TX_LOGS | TX_MESSAGE | TX_BALANCES`, copying
the shape of the SDK's examples. That hands each member a view of every other member's
submissions in exchange for nothing an incident needs.

The instruction now takes flags per member and VINCT's client passes zero. One consequence is
visible in the Phase 4 run: the rollup withholds transaction logs even from the wallet that
sent the transaction, so a refused attempt arrives as an error code with no log line. The
client resolves the code against the IDL instead. That is the permission working, and the
client adapting to it rather than asking for the privilege back.

### D-0035 A permission member can read a co-member's decision — WITHDRAWN

> Superseded by D-0042 and D-0043. The conclusion below was wrong: it read a property of the
> chosen storage layout as a property of the platform, without testing whether the platform
> required that layout. It did not. The record stays because the reasoning is the kind that
> looks sound and closes off a real design, and because the correction came from an
> experiment rather than from more reasoning.

An ephemeral permission gates an account, not a field. Every member reads the same bytes.

The Phase 4 run records the opener's read and a member's read of the live incident as having
identical digests. A member can therefore see every other member's decision and count the
tally for themselves. VINCT's instructions answer no such query and its client has no decoder
that reconstructs one, but the raw account is readable.

The fix would be commitments with a separate reveal round. The PRD rules that out in §7.3 for
a good reason: an all-member reveal turns a k-of-n threshold into an n-of-n liveness
dependency, and an incident response that stalls because one member is offline is a worse
failure than co-members seeing each other's votes.

Recorded as a documented limitation rather than an open task. It is in
`docs/privacy-boundary.md` under the class it belongs to, and VINCT does not claim
cryptographic sealing between co-members anywhere.

### D-0036 Authentication is not authorization, and the run proves it separately

A private rollup will not talk to an anonymous caller, so every participant completes a
challenge-sign-login flow and holds its own session token.

The temptation is to authenticate once and reuse the session, which would make the run cheap
and meaningless: it would never distinguish "this wallet may act" from "some wallet
authenticated". Every keypair in the Phase 4 run holds its own session, including the
outsider.

The outsider's session is valid. Its read of the incident account is refused outright, and
its attestation is rejected with `NotAnEligibleMember`. Those are two different boundaries,
one enforced by the permission and one by the program, and separating them is what lets the
artifact say which held.

Tokens are bearer credentials for a wallet's private view. `packages/client/src/per-auth.ts`
returns a `Connection` that carries one and a redacted URL for everything else; no token
reaches a log, an artifact, or a console.

### D-0037 A leak scan needs a positive control

The first Phase 4 run reported no canary on any surface, and that result was worth nothing on
its own. A scan for a marker that was never written passes for the wrong reason, and a
partial scrub, a mis-encoded argument, or a claim that silently failed to store would all
look identical to success.

The run now reads the live incident through the opener's session before the scrub and
requires every private field class to be found there. Six classes, six markers, all present
(`leakScan.positive_control`). Only then is the absence of those markers elsewhere evidence.

The verdict also refuses to pass on an unreadable surface. "Could not read" is recorded as
unproven and never counted as clean.

### D-0038 Every refusal is asserted by name

The first run's refusals all read "resulted in an error", which proves only that something
went wrong. A run can refuse everything for entirely wrong reasons and still look like a
passing boundary test.

Each attempt now declares the error it expects, and the verdict fails on a mismatch. Two
findings came out of making the reasons legible. The reasons live in the landed transaction
rather than in the send error, because ER sends skip preflight. And the reasons are not in
the logs, because D-0034's zero visibility flags mean the rollup withholds them, so the code
is resolved against the IDL instead.

### D-0039 The permission's authority is not the same question as who may set it

The ephemeral permission's authority is the incident PDA. The CPI passes
`authority_is_signer: false` and the permissioned account signs for itself, so no external
key can be the permission's authority. That reads like the access question is settled.

It is not. It settles who the *permission program* will accept as the authority. It says
nothing about who may ask `vinct_core` to make that call, and the first implementation asked
for nothing at all. `create_incident_permission` and `update_incident_permission` had no
signer in their contexts, so any funded wallet could add itself to a live incident's member
list and read every private field, or front-run the creation of a permission with a member
list of its own choosing.

Both now require the opener to sign, and `crates/vinct-program-tests/tests/privacy.rs`
asserts an intruder gets `NotTheOpener` on each.

`close_incident_permission` deliberately keeps no signer. It is gated on the terminal scrub,
and a scrubbed account has nothing left to expose, so the risk of leaving it open is nil
while the risk of closing it is real: requiring the opener would let a responder who dislikes
an outcome strand the account inside the rollup by never calling it. Same reasoning as the
permissionless scrub.

The general shape is worth keeping in mind. A CPI whose callee validates an authority makes
the callee safe. It does not make the caller's entry point safe, and reading the callee's
guarantee as covering both is how this got written in the first place.

### D-0040 The stale ER clone is an executable cache, not an account sync failure

D-0030 left open how a cached clone is refreshed. Phase 4 narrowed it considerably.

Deploying a new build to Devnet and then reading the program's `ProgramData` account from the
TEE rollup returns bytes identical to base, including the `last_deployed_slot`. The account
clone is current. `build_info` on the same rollup still returns the previous build's
fingerprint. What is stale is the rollup's executable cache, not its view of the account.

Three things do not clear it, all tested on 2026-08-07:

- delegating a new account to that validator
- sending a real transaction that invokes the program, rather than simulating one
- waiting through repeated probes over roughly fifteen minutes

Timing was the clue. The first upgrade propagated instantly, because that rollup had never
cloned the program before. Every upgrade after it did not. The cache is populated once, on
first use, and nothing VINCT can send appears to evict it.

Two consequences for how work is sequenced. A rollup that has already served a program for
one run cannot be assumed to serve the next build to the next run, so the freshness gate is
not a formality on repeat runs; it is most necessary exactly then. And because `cargo fmt`
changes the fingerprint, every edit has to be finished, formatted, built, and deployed as one
sequence. Formatting after a deploy costs a full upgrade cycle and then a wait.

Still open: what does evict it, and on what schedule. Routing to a rollup that has never
served the program remains the only reliable answer, and for a PER run there may be only one
attested rollup to choose from.

### D-0041 Delegation chooses the rollup, so delegation needs the opener

`delegate_incident` took an `opener: Signer` and never checked it against the account. Any
funded wallet could delegate someone else's incident.

The account is `Draft` at that point and holds nothing, which is why this reads as harmless
and is not. The caller passes the validator. A stranger who delegates a responder's incident
is choosing which rollup that responder's private claim lands on later, and there is no
second chance: an account is delegated once and everything private happens afterwards.

`#[delegate]` needs the account untyped, so there is no `has_one` to lean on. The check is by
hand, against the owner first and then the opener, in the same shape as the zeroization gate.

Two adjacent things this cost, both worth remembering. The check sits in the handler rather
than in a constraint, so it only runs once account validation has passed; the regression test
has to load a stub at the delegation program's address to get that far. And the first version
of that test appeared to fail for the wrong reason because `cargo test` runs against
`target/deploy/*.so`, which `cargo check` does not rebuild. A program test asserting new
behaviour needs `anchor build` first, or it is testing the previous build.

### D-0042 A PER permission gates reading, not touching

D-0035 concluded that a co-member can read another member's decision because "an ephemeral
permission gates an account, not a field". That sentence is true and the conclusion drawn
from it was wrong. The mistake was in the storage boundary, not in the platform.

The question nobody had answered: on a private rollup, must a wallet be inside an account's
permission to send a transaction that *mutates* it, or only to *read* it? The official
sealed-auction example does not settle it, because its auctioneer is a member of every bid's
permission and is the one who calls `end_auction`. No caller there ever touches an account it
cannot read.

`probes/per-visibility-probe` was built to answer it, and run against the attested Devnet
rollup by `scripts/per-visibility-experiment.ts`. Three delegated accounts:

- an aggregate whose permission names one member: the aggregate PDA itself. A PDA is off the
  ed25519 curve, so no key exists that can complete the rollup's challenge-sign-login flow as
  it. Nobody at all can read that account.
- one ballot per member, each private to that member alone.

Both members then cast, in transactions that write their own ballot and increment the
aggregate.

Every observation, from `artifacts/devnet/per-visibility-experiment-latest.json`:

- both casts landed
- A could read A's ballot; B could read B's
- A could not read B's ballot, and B could not read A's
- neither member could read the aggregate
- the payer that created all three accounts could not read the aggregate or either ballot
- an anonymous caller could read none of them
- after the run, opening the aggregate's permission showed 1 approval and 1 rejection: the
  program had been reading and writing an account no participant could see, and got it right

Execution authorization and query authorization are separate concerns on a PER. A program
can read and mutate an account that the transaction's sender cannot see.

So the sealed-quorum property VINCT wanted is reachable, and the single permissioned
`PrivateIncident` account was the wrong shape. D-0035 is withdrawn as a platform constraint
and reopened as an implementation defect. See D-0043 for the corrected architecture.

One detail worth keeping. A refused read comes back as *no account*, not as an error. An
observer cannot distinguish "you may not see this" from "this does not exist", which is a
better answer than a distinguishable refusal would be.

### D-0043 Sealed quorum is a storage boundary, and the first one was wrong

D-0035 recorded that a co-member can read another member's decision, and treated it as a
platform constraint. D-0042 showed it was not. This is the corrected architecture.

The old shape put everything in one permissioned `PrivateIncident` account: the claim, every
member's decision, the running counts. A permission gates an account, so every member had to
be inside that one permission, so every member could read all of it. The account was the
boundary and the boundary was wrong.

Three account classes now, and the split is the whole design.

`IncidentCore` is public and never permissioned. Covenant, policy, threshold, deadline,
status, member count, and the aggregate counts that only exist once the outcome is settled.
Nothing in it is worth hiding, so nothing needs a permission, and an observer gets the view
the PRD promises them (§24.3) by simply reading it.

`IncidentClaim` is private to the member set. Every member needs the evidence to decide, so
this is shared context rather than anyone's secret.

`MemberAttestation` is one account per member, private to that member alone. Not to the
opener, not to the payer, not to the other members. This is what the old shape could not
express.

And no account holds a live tally. Certification is handed every attestation at once and
counts them in memory. A running total would have to live somewhere, and anywhere it lived
would be readable by whoever could read that account. What is never stored cannot leak.

Four consequences worth stating.

Attestation accounts are created for every member when the incident opens, before anyone
votes. An account that appeared the moment a member submitted would announce that they had.

k-of-n liveness survives, which is why this is not commit-reveal in disguise. Certification
needs every attestation account *passed*, not every member to have *acted*. A silent member's
account exists, holds no decision, and contributes nothing.
`certification_does_not_wait_for_a_silent_member` is the test.

Quarantine now writes a flag into an account the opener cannot read. That is not a loophole,
it is the property D-0042 established, used on purpose.

Certification refuses uniformly. Before the deadline it succeeds only when the threshold is
met, and every other caller gets `IncidentNotTerminal` whatever the reason, so nobody can
distinguish "not enough approvals yet" from "already too many rejections". An incident that
is going to fail waits for its deadline instead of terminating early, so the moment a
blocking rejection lands is not observable either. The one bit certification does leak,
whether the incident has certified, is the public status anyway.

The reference model in `crates/vinct-reference` needed no change. It models transitions, not
storage, and the transitions are the same ones. That the split left it untouched is a small
piece of evidence that the model was drawn at the right level.

### D-0044 Certification reconstructs the ballot set instead of trusting it

The split-account model made certification depend on receiving the complete frozen ballot
set. The first version checked count, owner, incident binding, and PDA derivation, and
deduplicated by address. That is a list of plausible checks rather than a proof, and it left
a real hole: nothing tied the ballots to the *set* the incident froze.

Concretely, `initialize_attestation` will create a ballot for any key. An opener could create
four, open with three, and hand certification a different three of the four. Every account
would be a genuine, correctly derived ballot of that incident, and every individual check
would pass.

Two changes close it.

`open_incident` now takes the member list rather than a digest of it. It requires the list to
be strictly ascending, computes the commitment itself, and requires a ballot account to
already exist at the canonical address for every member before freezing anything. A caller
cannot hand in a digest of their own, and a set naming a member with no ballot is refused,
because freezing one would make certification impossible for the incident's whole life:
certification demands the complete set and nothing afterwards could create the missing one.

`certify_incident` then reconstructs. Every ballot is validated on its own, the members must
arrive strictly ascending, and the commitment recomputed over them has to equal the frozen
one. That single equality carries most of the invariants at once. A missing member, an extra
one, a duplicate, a ballot from another incident, and a ballot relabelled to another member
each either change the digest or fail an earlier check.

Ascending order is the canonical rule, and an out-of-order list is refused rather than sorted.
Sorting inside the program would mean committing to a set the caller did not send. It is also
the same rule `MemberSetV1` already follows, so there is one ordering convention rather than
two.

Strict ascent subsumes duplicate detection, so the separate `DuplicateAttestation` error is
gone rather than left unreachable.

Two further hardenings came out of writing the tests. `certify_incident` and `open_incident`
now constrain the core by its own seeds, so a caller cannot settle one incident's ballots
against another's threshold. And every account in the family carries a schema version that is
checked wherever it is read by hand, so a ballot written under a different layout is refused
rather than reinterpreted.

Eighteen adversarial tests, one per mutation, in
`crates/vinct-program-tests/tests/privacy.rs`.

### D-0045 A rejected incident is named at its deadline, not the moment it is blocked

The reference model returns `RejectedByThreshold` as soon as rejections pass the ceiling. The
program deliberately does not act on that, because settling the moment a blocking rejection
lands announces exactly when it landed.

The first version folded the rejected case into `Expired`, which removed the timing leak and
also removed information the covenant needs: a blocked incident and an unanswered one are
different situations for the people who have to respond to them.

`IncidentStatus::RejectedByThreshold` now exists and is written at or after the deadline. By
then the aggregate is published anyway, so naming the outcome precisely costs nothing, and
before the deadline both cases still refuse identically with `IncidentNotTerminal`.

That also makes the parity with the reference model exact rather than approximate, which is
what `crates/vinct-program-tests/tests/reference_parity.rs` now asserts over all 512 cases:
four choices per member, every quarantine subset, both sides of the deadline. The two
implementations share no code. The program counts by reconstructing a set of accounts from a
commitment; the model counts by walking a vector.

The one place they are allowed to differ is stated in the test rather than hidden: before the
deadline the model may already say `RejectedByThreshold` or `Impossible` while the program
still refuses to settle. The model is a view of the state, the program is a transition on it,
and they agree about the state.

### D-0046 The covenant is what stops the opener choosing the answer

Phase 4 left one thing unbound. The incident's opener supplied the member set, the threshold,
the rejection ceiling, and the response window. Certification then proved the ballots matched
the set that was frozen, which is a real guarantee about consistency and no guarantee at all
about legitimacy: an opener could freeze whatever set suited them.

Phase 5 puts a ratified covenant underneath. `initialize_incident` copies the snapshot out of
it, and opening takes no terms at all. The only argument left to `open_incident` is the digest
of the claim.

Formation is a sequence of separate signatures rather than one authority's decision. The
steward convenes and adds members and can do nothing else; each protocol ratifies its own
membership and nobody else's; ratifying the covenant requires every member to have done so;
each protocol arms its own adapter; and the circle is armed only when every adapter-owning
member has. The two covenant-level steps take no signer, because by then every signature that
mattered has been given, and requiring one more would let whoever held it stall a circle that
had already agreed.

Two details that matter more than they look.

The covenant's frozen member set uses the same commitment an incident's ballot set is checked
against, over the same canonical ascending order. Two derivations of the same set would be two
chances to disagree; binding an incident to a covenant is one equality.

Membership cannot change after ratification. A change is a new epoch rather than an edit,
because incidents already in flight carry the epoch they opened under and would otherwise be
evaluated against a set that moved under them.

The opener must now hold a ratified membership, which also sharpens the read matrix: the
principal who cannot read a peer's ballot is a peer, not an outsider.

### D-0047 A certificate is earned, not issued

Phase 2 gave `publish_certificate` every field as an argument and an `issuing_authority`
signer, with a docstring saying Phase 5 would replace it. Replacing it turned out to matter
more than the docstring implied: as written, any funded wallet could publish a certificate
saying anything, and an adapter had no way to tell one earned by a covenant from one typed by
a stranger. The signer's key was recorded, which localises the blame and prevents nothing.

There are no arguments now. Every field is derived from the released incident core: covenant,
epoch, policy, member set, template, operation ID, aggregates, and the certification slot.
The `issuing_authority` field holds the incident's own address, which is a better answer to
"which authority stood behind this" than a wallet was.

Publishing is permissionless, for the same reason certification and the scrub are. An incident
that reached its threshold must be able to produce its certificate, and requiring a signature
would hand whoever held it a veto over an outcome the covenant had already reached. The payer
funds the account and gains nothing by it.

The operation ID is computed by `vinct_types::action::operation_id`, the same function the
reference model and the standalone TypeScript verifier use, rather than a fourth
reimplementation. Its nonce is the certification slot: drawn once, at the only moment that can
produce a certificate for that incident, and public by the time anyone can read it.

Two consequences worth writing down.

The adapter tests forged certificates through that instruction. They now write the account
bytes directly, which is both what an attacker would have to do and a stronger test: they no
longer depend on the core program having a permissive entry point and would keep passing if it
had none.

`scripts/phase3-seam.ts` could manufacture the certificate its cohort settled against. It
cannot any more, and it now checks for one and says where to get it. That is the seam between
the two halves of the product becoming real rather than assumed.

### D-0048 A capability is bound to one operation, and arming happens before there is one

Wiring the Phase 5 end-to-end runner surfaced an ordering problem the earlier phases could
not have shown, because each of them only ever ran one operation whose ID the client chose in
advance.

`vinct_adapter`'s `ordered_account_metas_hash` commits to the concrete account list, and that
list contains `adapter_receipt`, a PDA seeded by `[ADAPTER_RECEIPT_SEED, operation_id,
capability]`. So a capability is armed against exactly one operation ID.

That was consistent through Phase 3, where `scripts/phase3-seam.ts` picked the operation ID
first and installed capabilities against it. It is not consistent with Phase 5. The operation
ID is now derived by the program at certification, from the frozen snapshot and the
certification slot, so it does not exist until the incident is over. A protocol cannot arm a
capability for an operation that has not happened yet.

And it has to. The covenant reaches `ARMED` only when every adapter-owning member has armed,
and an incident may only open under an armed circle. The whole product premise is arming
before the crisis rather than during it.

The direction is the one D-0015 already took for the bundle template and the adapter's metas
hash simply did not follow. The receipt is a *role* rather than an address: the commitment
covers the five accounts whose addresses a protocol genuinely fixes in advance, and the
adapter re-derives the expected receipt from `parsed.operation_id` and its own capability,
both of which it already validates. A capability is then armed once, for any operation under
its covenant, epoch, and policy, and the receipt binding is no weaker: the address is fully
determined by two values the adapter checks.

Not implemented yet, and deliberately not rushed. It changes what a protocol authority signs
when it arms an adapter, which is the most safety-critical signature in the system, and it
wants its own unit of work with the adversarial tests rewritten around the new commitment
rather than adjusted to fit it.

Until then the composition is proven up to the certificate: covenant, frozen snapshot,
pre-created ballots, private claim, sealed attestations, in-memory certification, terminal
scrub, release, and the certificate the adapter reads. The cohort beyond it is proven by the
Phase 3 evidence against a client-chosen operation ID, which is a real result about Magic
Actions and no longer the path Phase 5 takes.

### D-0049 The account audit for `execute_bounded_action`

Derived from the instruction context as it stands, not from the PRD's description of it.

| # | Account | Class | Why |
| --- | --- | --- | --- |
| 0 | `certificate` | dynamic | PDA `[CERTIFICATE_SEED, operation_id]` under the core program. The operation ID is drawn at certification. |
| 1 | `capability` | static | The capability itself, at `[CAPABILITY_SEED, protocol, covenant, policy]`. Every seed is known when the authority arms it. |
| 2 | `protocol_state` | static | The protocol's own market, chosen by its authority at install. |
| 3 | `receipt` | dynamic | PDA `[ADAPTER_RECEIPT_SEED, operation_id, capability]`. |
| 4 | `adapter_signer` | static | PDA `[ADAPTER_SIGNER_SEED, capability]`. |
| 5 | `target_program` | static | Chosen at install. |
| 6 | `escrow_auth` | dispatcher-injected | Appended by `#[action]`, non-mutable. Not part of what the authority chose. |
| 7 | `escrow` | dispatcher-injected | Appended by `#[action]`. |

Two dynamic, four static, two injected. That is the whole surface, and it makes the fix
narrower than the diagnosis suggested.

The adapter already re-derives or pins nearly everything: `adapter_signer` is seed-derived,
`protocol_state` and `target_program` are compared against the capability, and the receipt is
checked for its operation, its capability, and its own seeds. The only thing binding a
capability to one operation was `ordered_account_metas_hash`, computed over the *concrete*
addresses, and the certificate whose address was never derived at all — only its contents
were.

So the correction is not a new mechanism. `AccountRoleV1`, `TemplateAccountMetaV1`, and
`ActionTemplateV1` already exist in `vinct-types` from D-0015, with a closed role enum and no
seed DSL. The adapter simply never adopted them. Unifying means the capability commits to the
template's *shape* rather than to one operation's addresses, and the adapter re-derives both
dynamic slots itself.

The role positions do not need to be told to the adapter, because `execute_bounded_action`
declares a fixed account list: position 0 is the certificate and position 3 is the receipt, by
construction. The capability stores the commitment the authority signed and the adapter
rebuilds the same list from its own structure and its own pinned addresses. A shape the
authority did not sign produces a different digest.

### D-0050 A capability commits to a template, not to one operation's accounts

The correction D-0048 called for, implemented. Not a new scheme: `AccountRoleV1`,
`TemplateAccountMetaV1`, and `ActionTemplateV1` have been in `vinct-types` since D-0015, with
a closed role enum and no seed DSL. The adapter had simply never adopted them, and kept
committing to concrete addresses.

`SovereignCapability.ordered_account_metas_hash` is now `action_template_hash`. The adapter
rebuilds the same commitment at execution from its own accounts, with the two operation-derived
slots contributing their role and their flags and no address at all. A swapped market and
receipt, an added writable account, or a flipped signer flag still land there, because what is
committed to is the shape.

The two derived slots are re-derived rather than trusted. The receipt already was, three ways
over: its own seed constraint, its stored operation, and its stored capability. The certificate
was not — only its contents were checked, never its address — so the adapter now derives
`[CERTIFICATE_SEED, operation_id]` under the core program this capability named and requires
the supplied account to equal it. That was a genuine gap the audit surfaced, independent of
the reuse problem.

Role positions are not configurable and are not sent by anyone.
`execute_bounded_action` declares a fixed account list, so position 0 is the certificate and
position 3 is the receipt by construction. A template that let a client say which slots were
derived, or supply seeds for them, would be a forwarding surface wearing a commitment.

`ActionTemplateV1` now also binds what it was armed against: a layout version, the cluster,
the covenant, the epoch, the policy, and the action category, alongside the adapter program
and version, the target program, the discriminator, the ordered slots, the instruction bytes,
and the effect bound. One type, used by the types crate, the reference model, the program, and
the standalone verifier.

What this changes about what a protocol authority signs, which is the point:

`default_install_args` used to take an operation ID and no longer takes anything of the kind.
Arming is operation-independent, and the compiler said so — the parameter went unused the
moment the commitment changed. `one_armed_capability_serves_two_distinct_operations` proves it
end to end: one arming, two certificates, two receipts, both executed, neither able to consume
the other's receipt.

The capability's semantics are now explicit. Installed before incidents, reusable for any
valid incident under the same covenant, policy, and epoch, bounded by version, effect, and
expiry, suspendable and revocable by its own protocol authority, and replay-protected per
operation by a receipt. A certificate is the circle saying an incident happened; it is not the
protocol saying it is still willing to act.
`a_capability_suspended_after_certification_refuses_to_execute` holds that line.

### D-0051 A hand-written decoder does not fail, it lies

Re-running the local lifecycle after the template correction reported two approvals as fifty
and zero rejections as two hundred and thirty-nine, and still printed PASS.

Two separate faults, and the second is the one worth recording. The client's
`decodeIncidentCore` walks the account by offset, and three fields had been added to
`IncidentCore` since it was written, so every field after them was read from the wrong bytes.
A decoder that has drifted does not return an error. It returns numbers that look like
numbers.

The run passed anyway because its verdict only checked the status. A verdict that reads one
field from a decoder it does not trust is not checking the decoder at all.

Both are fixed, and both got a guard rather than a correction. The runner's verdict now
requires the aggregate to be the number the ballots actually produced, so a drifted decoder
fails the run. And `the_client_decodes_the_core_the_program_writes` builds a buffer to the
program's declared field order and checks every field, so the drift is caught in the test
suite before it reaches a runner at all.

The general shape: every hand-written decoder in this repository is a second implementation of
a layout, and the layout is the one that moves. Where one exists, something has to pin it.

### D-0052 Every decoder that produces evidence is pinned to a generated vector

D-0051 found one drifted decoder. This is the audit that followed, and the mechanism that
stops the next one.

Eleven accounts have hand-written TypeScript decoders: `Covenant`, `CovenantMember`,
`IncidentCore`, `IncidentClaim`, `MemberAttestation`, `IncidentCertificate`,
`SettlementReceipt`, `SettlementOperation`, `SovereignCapability`, `AdapterReceipt`, and
`ProtocolMarket`. They stay hand-written on purpose: the settlement monitor has to read
base-layer state without trusting a client library, and a judge has to be able to read one
file and check it against the program. What they cannot stay is unpinned.

`crates/vinct-layouts` builds each account from the program's own Rust struct, serialises it
the way Anchor does, and writes the bytes next to the values they encode.
`tests/program/account-layout-parity.test.ts` decodes those bytes and checks every field. A
field added, moved, resized, or reordered in Rust changes the vectors and the test fails until
the TypeScript follows. It is the only crate that depends on the programs as libraries, which
is the point: a vector written any other way would be a second opinion about the layout rather
than a record of it.

Every decoder now also fails closed three ways. The discriminator is asserted, so reading one
account as another throws instead of returning a plausible different account. The length is
asserted, so a truncated buffer or a `dataSlice` read throws instead of reading zeros off the
end. And the versioned accounts refuse a version this build does not know, rather than
interpreting an unfamiliar layout optimistically.

Two decisions inside that are worth stating.

The private accounts have decoders now, and they do not decode anything private. A claim and a
ballot are exactly what a client must not read, but a verifier legitimately needs the opposite
question answered: whether the protected region is actually zero once the incident is
terminal. So `decodeIncidentClaim` and `decodeMemberAttestation` return the public shell, the
zeroization flag, and a boolean computed from the protected bytes. If the region is not zero
that is reported as `false`, and the contents stay where they are.

The committed vectors carry a zeroed protected region. A fixture holding bytes that look like
evidence is a fixture somebody will eventually mistake for evidence.

### D-0053 The whole mechanism runs on a certificate nobody chose

Every previous cohort run picked an operation ID up front and published a certificate to match.
That proved the settlement half worked. It could not prove the two halves were the same
system, because the value joining them was chosen by the test.

`scripts/phase5-composition.ts` runs the sequence with nothing chosen. Three protocols form a
covenant, ratify their own memberships, and arm their own capabilities before any incident
exists. An incident opens under that covenant, collects a private claim and two sealed
attestations inside the rollup, certifies in memory, scrubs, and releases to base. The
operation ID is whatever `certify_incident` derived from the frozen snapshot. The certificate
is published permissionlessly from the released core. Only then is the cohort built, and it is
built from that operation ID.

Three runs, on the local stack:

| Run | What changed | Observed |
| --- | --- | --- |
| `success` | nothing | `ALL_ACTIONS_APPLIED` — three markets paused, three adapter receipts, settlement finalized |
| `--fail-one` | one protocol never registered its adapter signer | `COMMIT_WITHOUT_ACTIONS` |
| `--suspend-one` | one protocol suspended its capability after certification | `COMMIT_WITHOUT_ACTIONS` |

The two failure runs are the same classification, and that is the finding worth recording. One
BaseAction that cannot succeed removes the whole strategy, so the other two protocols' pauses
never landed either. Nothing partial was observed. This is why `COMMIT_WITHOUT_ACTIONS` is a
required state rather than an edge case, and why recovery is a governed proposal under a new
operation ID rather than a retry of the one action that appears to be missing: the other two
actions did not run, and retrying only the visible gap would leave the cohort half applied.

Every classification in all three runs is read from base-layer account state after the fact.
The scheduling signature is recorded as `INTENT_ACCEPTED` and used for nothing else.

The scrub was re-checked on base after release in all three runs. A settlement that fails does
not un-scrub an incident, which is worth stating because the failure paths are exactly where a
partially-applied cleanup would hide.

Artifacts: `artifacts/local-stack/phase5-composition-{success,fail-one,suspend-one}.json`.

### D-0054 Reuse, mutation, and replay, proven on earned certificates

D-0050 argued that a capability commits to a shape rather than to an operation.
`adversarial.rs` tested that against manufactured certificates, which is the right tool for a
refusal test: forging is the point when the question is whether a forgery is refused.

It is the wrong tool for the positive claim. "One arming serves every incident the covenant
certifies" cannot be demonstrated with certificates a test wrote, because a test that writes
two certificates has not shown that two incidents produce two certificates.

`composition.rs` now carries three tests that use only earned certificates:

`one_armed_capability_settles_two_certified_incidents` arms three protocols once, then runs two
separate incidents under the same covenant to certification. Both settle through the same
capabilities. Each market's `update_count` reaches two, each capability's nonce reaches two,
and no capability was re-armed, re-installed, or touched by its authority in between.

`a_real_certificate_does_not_license_a_mutated_bundle` takes one earned certificate and swaps a
single account of the canonical list for the corresponding account of a different armed
protocol — its market, its adapter signer, its capability. Every substitution is a real account
of a real protocol, so nothing is malformed, only mismatched. All three are refused, and the
canonical list still executes afterwards.

`a_certified_operation_settles_once` settles an earned operation and then retries both the
adapter execution and the settlement finalization. Three independent refusals stand in the way:
the adapter's receipt, the target protocol's own `last_operation_id`, and the settlement
receipt. All three are asserted rather than just one, because they fail at different layers and
a change that removes one should not be able to hide behind the others. The refused replay
moved no state.

Supporting this needed one fixture change: `World::refocus_on_covenant` re-seeds the fixture's
capabilities against a covenant that actually exists. The default fixture seeds them against an
opaque address, which is all the adapter tests need since they never certify anything. A
capability that must honour an earned certificate has to carry the real covenant in both its
PDA and its armed commitment.

### D-0055 The vectors were stale, and both sides agreed on the wrong layout

D-0052 pinned every TypeScript decoder to a generated vector. It did not pin the vectors to
the Rust.

`ActionTemplateV1` gained six fields in the capability-template correction: `template_version`,
`cluster_genesis_hash`, `covenant`, `circle_epoch`, `policy_id`, and `action_category`.
`gen-vectors` was never re-run. The committed vectors kept describing the old ten-field layout,
the TypeScript encoder kept matching them, and the parity test kept passing. Both sides agreed
with each other and neither agreed with the program.

It surfaced only because this phase added a new vector and regeneration was unavoidable. That
is not a detection mechanism, it is luck, so `scripts/check-vectors.sh` now regenerates both
vector files and fails on any diff. Committed vectors that are not what the Rust would produce
today are a failing build.

Two things were wrong and both are fixed. `template_action_json` emitted a subset of the
struct's fields, so even a fresh vector would not have described the whole thing; it now emits
every field. And the TypeScript `ActionTemplate` interface, writer, and reader now carry all
sixteen fields in the program's order.

The general rule: a cross-language vector is only evidence while it is current. A stale vector
is worse than none, because it converts a missing check into a passing one.

### D-0056 The settlement monitor is a module, and the runner classifies nothing

The composition runner used to decide its own verdict inline: three booleans, a ternary, and a
string. A runner that classifies its own run can be made to pass by editing the runner.

`packages/monitor` now owns it. `classify` is a mirror of
`crates/vinct-types/src/settlement.rs`, checked against it on all 729 observations of a
two-action cohort rather than on a handful of chosen cases. All four classifications are
reachable in that sweep, which is asserted separately: an earlier version of the generator
pinned one action to a fixed outcome and made `AllActionsApplied` unreachable, so the sweep
would have been exhaustive over a space that excluded the answer that matters most.

`observeSettlement` reads base-layer accounts with a per-read timeout and reports `NotObserved`
for anything it could not read. That distinction is the module's reason to exist. An RPC that
hangs and a cohort that did not deliver look identical to a naive observer, and reporting the
first as the second opens a recovery proposal for an operation that settled fine. There is a
test that runs the real observer against a server that accepts connections and never answers.

`packages/monitor/src/recovery.ts` turns a classification into a governed proposal, or refuses
with a reason. Only `CommitWithoutActions` permits one. `PartialObservation` is blocked
deliberately: a half-applied cohort means an assumption about transaction-strategy grouping was
wrong, and automating a retry before someone understands why is how a bounded action becomes
unbounded. The missing action list comes from the observations, never from the caller, because
a caller that names missing effects could name one that applied.

### D-0057 A router that disagrees with the chain resolves nothing

`resolveEphemeralEndpoint` fell through to the configured endpoint whenever the router failed
to produce a match, including the case where the router was up, published a routing table, and
that table did not list the validator the account is actually delegated to.

Those are different situations. A router that is down has no opinion, and the configured
endpoint is the honest fallback for the local stack. A router that lists routes and does not
list yours is a contradiction between two sources of truth, and substituting a configured
endpoint there would send delegated private state to a rollup the account is not delegated to.
That is D-0041's failure arriving from the other direction: there a stranger chose the rollup,
here a stale routing table would.

There is now a `router-mismatch` source that resolves no endpoint and says why. An empty
routing table stays an absence of evidence rather than a mismatch, because a router with
nothing to report contradicts nothing.

### D-0058 A bound receipt is not a settled one

`packages/verifier/src/operation.ts` verifies one real operation against the chain: it reads
the released core, reads the covenant that core names, checks the core's frozen snapshot really
is the covenant's terms, and re-derives the operation ID from those terms with the verifier's
own canonical implementation. Then it checks that the certificate, the settlement receipt, and
every adapter receipt carry that same ID. A judge needs the RPC and the artifact's addresses,
and nothing the artifact claims is trusted.

The first version got one thing wrong and it is worth recording. Its receipt checks were named
"settled the derived operation" while what they actually checked was the operation binding. Run
against the `--fail-one` artifact it printed `PASS alpha settled the derived operation` for a
cohort where nothing had executed: the receipts existed, because they are initialised before
scheduling, and they carried the right operation ID.

Identity and delivery are now separate. The checks verify that an operation ID is the honest
derivation of terms the members agreed to and that every account involved carries it. Delivery
is reported alongside, explicitly not verified, because a cohort that was scheduled and stripped
has correctly bound receipts and no effects. Folding the two together would let a verified
identity read as a completed settlement, which is the exact confusion the whole settlement model
exists to prevent.

### D-0059 The crank surface, answered against a running validator

Phase 0 carried an open question into Phase 6: which crank call path to use, raw
`MagicBlockInstruction::ScheduleTask` bincode or the SDK's `ScheduleCrankCpi`. Nothing in the
repository had ever sent either to a validator. `scripts/probe-crank.ts` asks directly.

Findings on the pinned local ephemeral validator (`mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`),
recorded in `artifacts/local-stack/crank-probe.json`:

`ScheduleTask` is variant 6 of the enum in `magicblock-magic-program-api 0.10.1`, and bincode's
default fixed-int encoding is what the validator accepts: enum discriminant as a little-endian
u32, sequence lengths as u64, `Pubkey` as 32 raw bytes, `bool` as one byte. The instruction is
accepted submitted directly, not only through a CPI, which the open question had assumed either
way without evidence.

The task context account slot is not enforced by this validator. A submission with the payer
alone was accepted, as was one with an arbitrary writable account in slot 1. VINCT will still
pass a meaningful account there, because a validator that does not check something today is not
a validator that never will.

The log line on success is `Scheduled task request with ID: <n>`, and cancel says
`Successfully added cancel request for task <n>`. Both say request. That is the PRD's crank
state machine appearing verbatim in the validator's own wording, and it is why a schedule
transaction's signature is `REQUESTED` and nothing more.

Execution was then observed independently, which is the part that matters. A task scheduled with
an inner `vinct_core::build_info` instruction produced this on the rollup:

```text
Program Magic11111111111111111111111111111111111111 success
Program Crank11111111111111111111111111111111111111 invoke [1]
Program 9BaZmGntudyAL5VodBWFCANchn7vx1Y7DNpXADbx6JcG invoke [2]
Program log: Instruction: BuildInfo
Program log: VINCT_BUILD_FINGERPRINT=60d9a7e93d967c0f281a2f32dc4f7fd320987dfbaec38fe1b89bff244d2b0ca9
Executed crank with 1 instructions
```

So the executor is the `Crank11111111111111111111111111111111111111` program, the transaction is
paid and signed by the validator identity rather than by the scheduling payer, and the inner
instruction runs as a CPI beneath it. A scheduled handler therefore cannot rely on the
scheduler's payer having signed anything.

One thing the probe did not confirm. A task requesting two iterations at a 1000ms interval
produced one observed execution in a 20 second window. Either the interval is not what it
appears to be at this scale, or iteration accounting differs from the argument's name. VINCT's
design does not depend on the answer, because the expiry handler is a no-op before the deadline
and idempotent after it, but nothing in this repository may assume a requested iteration count
is a delivered one.

Two consequences for the design. The scheduled instruction is built inside the program, never
supplied by the caller, so no caller can schedule an arbitrary instruction under VINCT's
identity. And the permissionless manual expiry path stays, because a crank whose exact timing is
not guaranteed cannot be the only way an incident reaches a terminal state.

The skill's reference describes a per-authority `crank_signer_pda(task_authority)`, while the
pinned `magicblock-magic-program-api 0.10.1` exposes a single global `CRANK_SIGNER` derived from
`["crank-executor"]` under `Crank1111...`. VINCT depends on neither: its expiry handler is
permissionless by design, so the scheduled instruction carries no signer meta at all and there
is nothing for the handler to validate an authority against.

### D-0060 Whoever schedules the task owns it, so the opener must be the one who does

The first Phase 6 run scheduled the expiry task with a payer and cancelled it with the
incident's opener. Both transactions succeeded. The task then ran all 32 of its requested
iterations.

The scheduler takes the signer of the schedule request as the task's authority, and a cancel
from any other key is not refused. It is accepted, stashed, and silently dropped when applied.
The crank reference says this outright and it is still worth having watched happen: a
wrong-authority cancellation looks identical to a working one from the client's side, because
both are requests and neither reports back.

So `request_expiry_crank` now requires the opener's signature, checked against `core.opener`,
and the opener is what goes into the CPI. One key schedules, one key cancels, and they are the
same key. Anyone else asking for the task is refused at the program rather than at a scheduler
that will not tell them.

The corrected run cancels after 7 of 32 iterations and the task stops.

### D-0061 A task that ran out of iterations is not a task that was removed

The same first run exposed a fault in the observer, and it is the more dangerous of the two.

`watchCancellation` established removal by watching the iteration count hold still. When the
task ran to exhaustion the count held still for exactly that reason, and the monitor reported
`REMOVAL_OBSERVED` for a cancellation that had done nothing. The artifact said the cancel
worked. The chain said the task ran to completion.

The observer now takes the requested iteration count and refuses to call exhaustion removal.
`iterationsExhausted` is reported separately, and a run whose count reached the request cannot
reach `REMOVAL_OBSERVED` at all. The script's verdict requires the same thing, so a cancel run
that passes has to have stopped a task that was still running.

The general shape is worth naming, because it is the second time this build has produced it.
Absence of evidence is being used as evidence of absence, which is sometimes the only tool
available, and the way to use it honestly is to enumerate the other things that produce the
same silence. Here there was exactly one and it was the common case.

### D-0062 What a task does after its accounts leave the rollup

The crank reference warns that undelegating or closing a task's accounts while it is still
scheduled creates a predictable failure path. VINCT's exposure is narrower than the general
case, because `release_incident` requires a terminal status: an incident that is still
collecting cannot be undelegated at all, whatever a caller wants.

What remains is the window after a terminal incident is released while a finite task still has
iterations left. The `expire` run measured it. After the release, 11 further iterations fired
and all 11 failed, with `AccountOwnedByWrongProgram` and `InvalidWritableAccount`.

Both refusals come from the runtime and Anchor's account checks, before any VINCT code runs.
Nothing was corrupted, the incident stayed `Expired` on base, and the scrub still verified.
That is the outcome the design wants and it is now measured rather than assumed.

It is also the argument for `MAX_EXPIRY_ITERATIONS`. A finite task's failures end. An unbounded
one would produce this forever, and an operator watching a task that fails every iteration
cannot tell a harmless tail from a real problem.

### D-0063 The crank state machine, and what each state is actually made of

PRD section 11.6 names six states. `packages/monitor/src/crank.ts` implements them, and each
one is worth saying where its evidence comes from, because they are not equally strong.

`REQUESTED` is a transaction. It is the only state that is, and it means what the validator's
log says: a request was stashed.

`REGISTRATION_OBSERVED` is inferred from the first observed execution, not from a registry.
This validator exposes no way to ask whether a task is registered, so the inference is one-way:
a task that is registered and has not yet fired reads as `REQUESTED`. Under-reporting is the
safe direction and the module never reports the other one.

`ITERATION_OBSERVED` requires a rollup transaction in which the crank executor is among the
accounts and the executor's own completion marker is in the logs. Matching on the target
program alone would count ordinary user transactions, which is how a state machine ends up
reporting an iteration that a person performed by hand.

`DESIRED_STATE_REACHED` is the incident's own status, read from the account.

`CANCELLATION_REQUESTED` is a transaction, with the same weight as `REQUESTED` and no more.

`REMOVAL_OBSERVED` is absence over a quiet window, with exhaustion excluded. See D-0061.

`safeToUndelegate` is the one question the module exists to answer, and it is deliberately
conservative: either removal was observed, or the incident is terminal and the handler will
no-op for whatever iterations remain.

### D-0064 The web product reads a chain and holds nothing

`apps/web` is a static Vite bundle. There is no server, no session, and no database, and that is
a protocol decision rather than a hosting preference. A service that could answer "did this
settle" would become a second source of truth about a settlement, and the entire settlement
model exists because that answer has to come from base-layer accounts.

Consequences worth naming.

Every endpoint is a query parameter, and none is a secret. A proof link carries the cluster it
was taken against, which is what makes the no-wallet path shareable: open the link, read the
checks, verify nothing about this page.

The one value the browser persists is a covenant address, under a single storage key.
Addresses are public on chain. `tests/web/privacy.spec.ts` walks every route and fails if any
other key appears, or if anything resembling a claim, a decision, a nonce, or a signature
reaches storage.

The app contacts its own origin and the RPC endpoints the user named, and nothing else. No font
CDN, no analytics, no error reporter. A third party learning when somebody opens an incident
page is a privacy leak that no amount of on-chain correctness prevents, so the test asserts the
absence of off-origin requests directly rather than trusting a policy.

The incident room shows the shape of the private state and not its contents, and says so. It
holds no member key and opens no authenticated rollup connection, so it cannot read a ballot.
The alternative, a browser holding member keys and caching decrypted ballots, would move
private material outside the boundary the whole design exists to hold. Stating the limit is
better than a page that looks capable and quietly is not.

### D-0065 `createHash` had to go, and the vectors proved the replacement

The shared packages hashed with `node:crypto`, which does not exist in a bundle. Rather than
polyfill it, `packages/client/src/sha256.ts` now wraps `@noble/hashes`, which is already in the
tree beneath `@solana/web3.js`, is synchronous, and behaves identically in both runtimes.

The reason this was safe to do at all is that every canonical digest in this repository is
pinned to vectors generated from Rust. Swapping the hash implementation under five modules is
the kind of change that silently alters a commitment, and the 70 TypeScript tests passing
unchanged afterwards is what says it did not.

Two other Node-only surfaces moved rather than being polyfilled. `packages/client/src/ids.ts`
now imports the built IDL JSON instead of reading it from disk, so a bundle carries the IDL of
the build it was made from. And `freshness.ts`, which walks the source tree to compute a build
fingerprint, left the client barrel: it is a proof-script tool and has no business in a browser
bundle. `packages/verifier/src/browser.ts` is the same split for the verifier, excluding the
committed-vector reader. A page that could check itself against vectors it shipped would be
proving nothing; it verifies against the chain instead.

### D-0066 vite preview binds to ::1, and the failure looks like nothing

Worth one paragraph because it cost time and will cost it again. `vite preview --port 4173`
binds to `localhost`, which resolves to `::1` on macOS. A Playwright `baseURL` of
`http://127.0.0.1:4173` then cannot connect, and the run hangs in `webServer` startup with no
output at all, which is indistinguishable from a slow build. `--host 127.0.0.1` is the fix and
it is now in `playwright.config.ts` with a comment saying why.

### D-0067 Four things the browser suite caught that nothing else could

Every one of these passed a typecheck, a build, and every program test. They are the argument
for running a browser at all.

`Buffer` is not a browser global. `packages/client` decodes accounts with
`Buffer.readBigUInt64LE`, and `@solana/web3.js` v1 assumes it exists. The app died on load with
a blank page. `apps/web/src/polyfill.ts` shims it, imported first, before anything touches it.
Rewriting the decoders against `DataView` was the alternative and it would have meant two
implementations of the layouts the whole decoder-drift argument exists to prevent.

The proof page passed capability addresses where adapter receipt addresses belong. It read a
capability as a receipt, and `expectAccount`'s discriminator check refused it with
`AdapterReceipt: discriminator mismatch` instead of returning a plausible wrong answer. That is
D-0052 paying for itself on a surface written months after it.

Two pages read `capability.authority`, and the field is `protocolAuthority`. It rendered
`Cannot read properties of undefined`.

That third one should have been a type error, and finding out why exposed the fourth.
`tsconfig.web.json` extended the base config, and `exclude` is inherited rather than merged
with `include`. The base excluded `apps`, so the web project resolved to zero files and `tsc`
reported success while checking nothing. The whole app had never been typechecked. Overriding
`exclude` turned up the missing path aliases and an `exactOptionalPropertyTypes` violation too.

The check that found it is worth keeping as a habit: break something on purpose and confirm the
gate fails. A typecheck that has never been seen to fail is not evidence that the code is
correct.

### D-0068 Two layout bugs where the control stayed visible and stopped working

Both from the mobile project, and both a worse failure than a broken layout.

The nav is sticky and its links wrap to two rows on a phone, so the bar took a third of the
viewport and sat on top of whatever the reader scrolled to. Playwright resolved the button,
found it visible, enabled, and stable, and then timed out clicking it. It is now static below
720px: a two-row sticky bar on a phone is bad design regardless of the test.

The proof and formation forms were flex with a 420px flex-basis on the label. On a narrow
screen the label kept its basis, overflowed the row, and covered the button that had wrapped
below it, so the input intercepted every click aimed at Verify. They are grids now, one column
below the breakpoint, with the input's `min-width` zeroed so it shrinks instead of pushing. A
grid cannot produce this failure at all.

Worth naming the shape: a control that is visible and unclickable is harder to notice than one
that is missing, and neither a screenshot nor a human skim reliably catches it. An actionability
check does.

### D-0069 Playwright's ESM loader deadlocks under Node 24

Recorded because the symptom is silence. Playwright 1.52 hangs at `load tests` for any spec
inside a package with `"type": "module"` on Node 24.14.1, including a spec whose entire body is
`expect(1).toBe(1)`. No output, no error, no timeout. The same file outside the repo loads
instantly, which makes it look like a project problem rather than a version one.

Upgrading to 1.57.0 fixes it. The bisection that found it is the useful part: trivial spec
outside the repo works, trivial spec inside the repo hangs, so it is neither the test content
nor the config, and a `.js` spec hanging too rules out the TypeScript transform.

Separately, `vite preview` binds to `localhost`, which is `::1` on macOS, so a `baseURL` of
`127.0.0.1` cannot connect and the run hangs in `webServer` startup with no output either.
`--host 127.0.0.1` is in the config with a comment, because two silent hangs with the same
symptom and different causes is a bad afternoon.

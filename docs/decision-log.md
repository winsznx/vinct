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

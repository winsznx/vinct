# VINCT Source Lock

Phase: 0 (source and compatibility lock)
Locked: 2026-08-07
Machine-readable companion: `artifacts/source-lock/version-report.json`

Every version below was read from a live command, a registry query, a committed
lockfile, or an upstream manifest during Phase 0. Nothing here is carried over from
memory. Regenerate the companion artifact with `pnpm source-lock` and assert it is
current with `pnpm source-lock -- --check`.

## Upstream sources

| Source | Repository | Commit | Commit date | How it was resolved |
|---|---|---|---|---|
| MagicBlock development skill | `magicblock-labs/magicblock-dev-skill` | `b6edd28e7f6b4433de5e6fbfe316f97efe36181f` | 2026-07-22 | `git ls-remote … HEAD` then shallow clone; installed to `.claude/skills/magicblock` |
| Solana development skill | `solana-foundation/solana-dev-skill` | `d4ecf1674ebae1be3a899e0998aa0318fe67c96e` | 2026-08-07 | `git ls-remote … HEAD` then shallow clone; installed to `.claude/skills/solana-dev` |
| MagicBlock engine examples | `magicblock-labs/magicblock-engine-examples` | `a291e4b2c9cc4bab6918ff434d9aaa72c702cf29` | 2026-07-28 | `git ls-remote … HEAD` then shallow clone; inspected out-of-tree, not vendored |

Both skills were installed by running each repository's own `install.sh` at project
scope. The installers copy files instead of cloning, so each installed skill carries a
`.source-lock.json` pin recording the repository and commit it came from. The engine
examples commit lives in `docs/upstream-pins.json`. `scripts/source-lock.ts` reads both
and reports `null` with a reason if either pin is missing.

The MagicBlock skill commit is identical to the planning snapshot named in the PRD.
The engine examples commit is also identical to the PRD's planning snapshot. Both were
still `HEAD` of their default branches on 2026-08-07.

Skill references read before writing the probe: `SKILL.md`, `architecture-planning.md`,
`security.md`, `magic-actions.md`, `cranks.md`, `delegation.md`, `local-development.md`,
`resources.md`, and the Solana skill's `compatibility-matrix.md`.

## Examples inspected

Selected as the working reference line, at the commit above:

- `magic-actions/anchor` — Magic Actions, `CallHandler`, `MagicIntentBundleBuilder`
- `private-counter/anchor` — PER `EphemeralPermission` create / update / close on the ER
- `crank-counter/anchor` — crank scheduling CPI and its dependency line
- `delegation-actions/anchor` and `sealed-auction/anchor` — cross-checked; same line

All five pin `anchor-lang 1.0.2` and `ephemeral-rollups-sdk 0.16.2`. The two examples
that use PER add the `access-control` feature. VINCT needs every one of these surfaces
in one crate, which no single upstream example does, so the compatibility probe combines
them.

## Locked toolchain

| Component | Version | Evidence |
|---|---|---|
| Rust (host) | `1.89.0` | `rust-toolchain.toml`; `rustc --version` |
| Cargo | `1.89.0` | `cargo --version` |
| rustup | `1.29.0` | `rustup --version` |
| Solana CLI | `3.1.9` | project-pinned in `.toolchain/solana`; `solana --version` |
| `cargo-build-sbf` | `3.1.9` | `cargo-build-sbf --version` |
| Platform tools | `v1.52` | `cargo-build-sbf --version` |
| Anchor CLI | `1.0.2` | `avm install 1.0.2`; `anchor --version` |
| Node | `24.14.1` | `node --version` |
| pnpm | `10.33.0` | `pnpm --version`; `packageManager` field |

Rust `1.89.0` is the version the skill's known-good snapshot names and the only version
any engine example pins (`ephemeral-account-chats/anchor/rust-toolchain.toml`).

The Solana CLI is installed **per project** under `.toolchain/solana` by
`scripts/bootstrap-toolchain.sh`, using an explicit `agave-install --config` inside that
directory. The machine-wide installation is untouched and stays on whatever release the
developer already had. `scripts/toolchain-env.sh` prepends the pinned `bin` to `PATH`.

Why 3.1.9 and not the globally installed 2.1.11: `cargo-build-sbf` from the 2.1.x line
ships platform tools v1.43 with rustc 1.79.0, which cannot build `anchor-lang 1.0.2`.
The Solana skill's compatibility matrix pairs Anchor 1.0.x with Solana CLI 3.x and
platform tools v1.52, and 3.1.9 is the release the MagicBlock skill's known-good snapshot
names. Agave 3.1.9 still ships `solana-test-validator`, which the local MagicBlock stack
needs.

## Locked Rust dependencies

```toml
anchor-lang = { version = "=1.0.2", features = ["init-if-needed"] }
ephemeral-rollups-sdk = { version = "=0.16.2", features = ["anchor", "access-control"] }
magicblock-magic-program-api = { version = "=0.10.1", default-features = false }
bincode = "=1.3.3"
sha2 = "=0.10.9"
```

Resolved transitively and pinned in `Cargo.lock`:

| Crate | Version |
|---|---|
| `anchor-lang` and every `anchor-*` macro crate | `1.0.2` |
| `anchor-syn` | `1.0.2` |
| `anchor-lang-idl` | `0.1.2` |
| `ephemeral-rollups-sdk` | `0.16.2` |
| `magicblock-magic-program-api` | `0.10.1` |
| `magicblock-delegation-program-api` | `3.1.0` |
| `solana-program` | `2.3.0` |

`ephemeral-rollups-sdk 0.16.2` is the current `max_stable_version` on crates.io as of
2026-08-07, confirmed by `curl https://crates.io/api/v1/crates/ephemeral-rollups-sdk`
and `cargo info`.

The `anchor` feature selects the Anchor 1.x line; `anchor-compat` targets Anchor
`>=0.28,<1.0`. See the adversarial results below for the counterexample that settles it.

Cargo's default resolution pulled `anchor-attribute-*`, `anchor-derive-*`, and
`anchor-syn` up to `1.1.2` while `anchor-lang` stayed at `1.0.2`. The upstream examples
resolve all of them at `1.0.2`, and the Solana skill's matrix warns that Anchor 1.1.2
tightened its inter-crate pins. `cargo update --precise` was used to bring the whole set
back to `1.0.2` so the lockfile matches the combination MagicBlock actually tests.

`magicblock-magic-program-api` is held at `0.10.1`, the version the SDK itself depends on
and the version the crank example declares. crates.io publishes `0.13.19`; adopting it
would put two copies of the API in the tree, so it is deliberately not taken.

## Locked TypeScript dependencies

```json
{
  "@coral-xyz/anchor": "0.32.1",
  "@magicblock-labs/ephemeral-rollups-sdk": "0.14.3",
  "@solana/web3.js": "1.98.4",
  "magic-router-sdk": "1.0.10",
  "@magicblock-labs/ephemeral-validator": "0.13.19",
  "typescript": "5.9.3",
  "@types/node": "24.13.3",
  "tsx": "4.23.11",
  "prettier": "3.9.6"
}
```

Every version is exact, with no ranges, and is locked in `pnpm-lock.yaml`.

`@coral-xyz/anchor` stays at `0.32.1` even though the on-chain program is built with
`anchor-lang 1.0.2`. The MagicBlock skill states this pairing explicitly and every engine
example uses it. `0.32.1` is also the current npm `latest`, so there is nothing newer on
that line to take.

`@magicblock-labs/ephemeral-rollups-sdk` stays at `0.14.3`, the version the engine
examples run their tests against, even though npm `latest` is `0.16.2`. The two were
compared file by file: the emitted `.d.ts` surfaces are identical except that `0.16.2`
adds one exported constant (`TOKEN_2022_PROGRAM_ID`). Since there is no functional
difference in the surfaces VINCT uses, the version MagicBlock actually tests wins. Revisit
at Phase 3 or 4 if a permission or intent encoding turns out to differ at runtime.

Solana client stack: `@solana/web3.js` v1, matching every engine example.
`@solana/kit` is not a dependency anywhere. If kit interop is ever needed it stays behind
`packages/client`, per the PRD.

Node `>=22.0.0` is declared in `engines`; the machine runs `24.14.1`. The known-good
snapshot names Node `24.10.0`, and Anchor 1.0.x requires `>=17`.

## Local MagicBlock stack

`@magicblock-labs/ephemeral-validator@0.13.19` (npm `latest` on 2026-08-07; the skill's
known-good snapshot named `0.13.7`). `scripts/bootstrap-local.sh` drives `mb-stack`.

Ports, as started by this repository:

| Service | HTTP | WS |
|---|---|---|
| base validator | `127.0.0.1:8899` | `127.0.0.1:8900` |
| ephemeral validator | `127.0.0.1:7799` | `127.0.0.1:7800` |
| query filtering service (public entry) | `127.0.0.1:6699` | `127.0.0.1:6700` |

One packaging gap had to be worked around. The ephemeral validator refuses to start
unless its identity `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev` holds at least 5 SOL on
base, and the account dump shipped inside `@magicblock-labs/ephemeral-validator@0.13.19`
funds it with `53432154` lamports (0.0534 SOL). Starting `mb-stack` with package defaults
fails with `ValidatorInsufficientlyFunded(mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev, 5)`.
`scripts/bootstrap-local.sh` re-declares that account from
`scripts/fixtures/local-er-validator-identity.json`, which is the packaged dump with
lamports raised to 100 SOL. Extra `mb-stack` arguments are forwarded to
`solana-test-validator` and applied last, so the re-declaration wins. The fixture holds no
key material.

## Live service state

Captured with `pnpm check-magicblock-status`. Latest capture:
`artifacts/source-lock/magicblock-status-devnet-latest.json`.

At 2026-08-07T16:27:57Z on devnet, `er`, `rpc_router`, `pricing_oracle`, and `vrf_oracle`
were operational in `asia`, `europe`, and `usa`. In the `tee` region,
`devnet-tee-as.magicblock.app` reported `er`, `pricing_oracle`, and `vrf_oracle`
operational and **`rpc_router` DOWN**. Phase 4 depends on the TEE-backed PER path, so that
status has to be re-checked before any PER rehearsal.

## Live router state

Captured with `pnpm exec tsx scripts/probe-router.ts`. Latest capture:
`artifacts/source-lock/router-probe-latest.json`.

`https://devnet-router.magicblock.app/` advertised four routes on 2026-08-07:

| Country | FQDN | Identity |
|---|---|---|
| USA | `https://devnet-us.magicblock.app/` | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| SGP | `https://devnet-as.magicblock.app/` | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| DEU | `https://devnet-eu.magicblock.app/` | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| SGP | `https://devnet-tee.magicblock.app/` | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |

No endpoint from this table is hardcoded anywhere in the repository. Two things about it
are recorded rather than assumed:

1. The router advertises the TEE endpoint as `devnet-tee.magicblock.app`. The status API
   keys the same region's server as `devnet-tee-as.magicblock.app`. They are different
   strings and must not be treated as interchangeable.
2. `getDelegationStatus` for an **undelegated** account returns `{"isDelegated": false}`
   and nothing else. Whether a delegated account's response carries an `fqdn` is
   unverified. See the open question below.

## Compatibility probe

`probes/magicblock-compat-probe` is one Anchor program that touches every MagicBlock
surface VINCT depends on. It holds no product logic and is not deployed.

Surfaces covered:

- `#[ephemeral]` on the program module, before `#[program]`
- `#[delegate]` context and the generated `delegate_<field>` helper with `DelegateConfig`
- `#[commit]` contexts, `MagicIntentBundleBuilder::commit` and `::commit_and_undelegate`
- `MagicIntentBundleBuilder::magic_fee_vault` — the commit-sponsorship path
- Magic Actions: `#[action]` target context, `CallHandler`, `ActionArgs`,
  `ShortAccountMeta`, `add_post_commit_actions`, `build_and_invoke`, and
  `build_and_invoke_signed` with PDA escrow authority
- PER access control: `CreateEphemeralPermissionCpi`, `UpdateEphemeralPermissionCpi`,
  `CloseEphemeralPermissionCpi`, `EphemeralPermission::size_of`,
  `ephemeral_accounts::rent`, `Member` flags, `PERMISSION_SEED`
- SDK constants `MAGIC_PROGRAM_ID`, `PERMISSION_PROGRAM_ID`, `EPHEMERAL_VAULT_ID` rather
  than copied literals
- Cranks: both the SDK's `ScheduleCrankCpi` / `CancelCrankCpi` and the raw
  `MagicBlockInstruction::ScheduleTask` bincode encoding the crank example uses
- `sha2` for deterministic digests, in the same dependency tree

Results:

| Command | Result |
|---|---|
| `cargo check --workspace --all-targets` | pass |
| `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| `cargo fmt --all -- --check` | pass |
| `cargo build-sbf` | pass, `target/deploy/magicblock_compat_probe.so` (427,376 bytes) |
| `anchor build` | pass, IDL and TS types emitted |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |

This proves the dependency combination compiles and links to a deployable SBF object. It
proves nothing about runtime behaviour on any network.

### Three API details the examples do not transfer verbatim

1. `CpiContext::new` in `anchor-lang 1.0.2` takes a `Pubkey` program id, not an
   `AccountInfo`. The skill's `delegation.md` snippet passes `to_account_info()`; the
   `private-counter` example passes `.key()`. Only `.key()` compiles.
2. The SDK's `ScheduleCrankCpi` and `CancelCrankCpi` take `&'a AccountInfo<'a>`.
   `AccountInfo` is invariant in its lifetime, so references built from
   `to_account_info()` inside an instruction handler cannot satisfy it — the borrow would
   have to outlive `'info`. They are usable from `ctx.remaining_accounts`, which is
   already `&'info [AccountInfo<'info>]`. The probe demonstrates both: the raw bincode
   path for a normal typed context, and the SDK builder driven from `remaining_accounts`.
   Phase 6 has to choose one deliberately.
3. `#[action]` appends `escrow_auth` (an `UncheckedAccount`, not mutable) and `escrow`.
   An action target therefore cannot use `init` or `init_if_needed` with `escrow_auth` as
   payer. Magic Action target accounts must already exist on base before scheduling.

## Adversarial cases

| Case | Method | Result |
|---|---|---|
| Incompatible Anchor feature | Probe source rebuilt with `ephemeral-rollups-sdk` feature `anchor-compat` instead of `anchor`, against `anchor-lang 1.0.2` | 71 compile errors. Confirms `anchor` is required for the 1.x line. A dependency-only crate with the wrong feature still compiles, so feature choice must be validated against real macro use, not `cargo check` on a stub. |
| Stale copied example | Compiled the skill and example snippets unmodified | Three call sites do not transfer verbatim; see above |
| Unavailable npm package | `npm view @magicblock-labs/ephemeral-rollups-sdk@0.99.0` | `E404 No match found for version 0.99.0` |
| Unavailable crate version | `cargo add --dry-run ephemeral-rollups-sdk@0.99.0` | `could not be found in registry index` |
| Status API unavailable | `VINCT_STATUS_API=https://status.magicblock.app.invalid/... pnpm check-magicblock-status` | Non-zero exit, artifact written with `reachable: false` and the error text. No health claim is produced from a failed fetch. Retained as `artifacts/source-lock/magicblock-status-devnet-2026-08-07T16-27-44-287Z.json`, whose `source` field names the deliberately invalid host. |
| Local stack child survives shutdown | `scripts/bootstrap-local.sh cycle` | Start in 5s, `getHealth` verified independently on base, ER, and QFS, then stop. Zero surviving processes across `mb-stack`, `mb-test-validator`, `ephemeral-validator`, `query-filtering-service`, `solana-test-validator`. Recorded in `artifacts/local-stack/stack-lifecycle.json`. |

## Open questions carried into later phases

1. Does router `getDelegationStatus` return an `fqdn` for a **delegated** account? The PRD
   says to resolve the ER endpoint from it, but the pinned SDK types it as
   `{ isDelegated: boolean }` and the live devnet router returned exactly that for an
   undelegated account. Re-run `scripts/probe-router.ts --account <delegated pubkey>`
   once a real delegated account exists. If the field is absent, endpoint resolution has
   to come from `getRoutes` plus the validator identity in the delegation record, and the
   PRD's routing section needs a correction.
2. TypeScript SDK `0.14.3` against Rust SDK `0.16.2`. Surfaces are identical today; a
   runtime difference in permission or intent encoding would force a bump.
3. Which crank call path to use (raw bincode versus SDK CPI via `remaining_accounts`).
4. `tee/rpc_router` was DOWN on devnet at lock time. Re-check before Phase 4.
5. Commit sponsorship. The `magic_fee_vault` builder method compiles, but the canonical
   vault PDA and the delegated-payer requirement are unverified against a live validator.
6. Whether all four Magic Actions stay in one `TransactionStrategy`. Unanswerable without
   Phase 3 devnet evidence, and nothing in this repository may assume they do.

## Regenerating this lock

```bash
bash scripts/bootstrap-toolchain.sh          # pin the Solana CLI under .toolchain/
pnpm install --frozen-lockfile
pnpm check-magicblock-status                 # live service state
pnpm exec tsx scripts/probe-router.ts        # live routing table
pnpm source-lock                             # artifacts/source-lock/version-report.json
pnpm source-lock -- --check                  # assert the artifact is current
```

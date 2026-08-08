# Running a Devnet proof

Everything here was learned by getting it wrong first. Each section says what goes wrong,
how it looks when it does, and what to do about it.

## Before every run: check freshness

An ephemeral rollup can keep executing a program it cloned before an upgrade. The base layer
reports the new build, the rollup runs the old one, and the failure that follows looks like
an ordinary application error rather than a stale binary.

This is not hypothetical. Phase 3 lost an afternoon to an `InvalidActionCount` where every
account value the check tested was correct; the only tell was that the Anchor error's line
number belonged to the previous build (`docs/decision-log.md` D-0030).

Every proof script now compares three fingerprints before it collects anything:

```
pnpm exec tsx scripts/phase4-per.ts
```

```
Checking runtime freshness before anything is proven
  https://devnet-tee.magicblock.app/       FRESH
```

The four verdicts:

| Verdict | Meaning | Do |
| --- | --- | --- |
| `FRESH` | Checkout, base, and rollup all agree | Proceed |
| `STALE_BASE` | The deployment is not this checkout's build | Deploy, then rerun |
| `STALE_ER` | The rollup is serving a cached clone | Try another attested endpoint; if there is none, wait |
| `UNDETERMINED` | A runtime did not answer `build_info` | Treat as not fresh and find out why |

`UNDETERMINED` is not a pass. An unanswered check is not a passed check.

A blocked run writes `verdict: BLOCKED_STALE_RUNTIME` with the endpoints it tried and stops.
No artifact from a stale rollup is ever collected.

### When the rollup is stale and there is no alternative

Phase 3's workaround was to delegate to a different validator. That works when several
rollups can serve the account. It does not work for a PER run, because only the attested
endpoint will do.

Observed on 2026-08-07: after a successful base-layer upgrade, the TEE rollup continued to
report the previous fingerprint. The first upgrade propagated immediately because the rollup
had never cloned the program; the second did not, because by then it had.

What is stale is the rollup's executable cache, not its view of the account. Reading the
program's `ProgramData` from the rollup returns bytes identical to base, `last_deployed_slot`
included. Neither a fresh delegation nor a real transaction that invokes the program clears
it (D-0040).

There is no known instruction that forces a re-clone. Wait for it:

```
pnpm exec tsx scripts/await-fresh-runtime.ts && pnpm exec tsx scripts/phase4-per.ts
```

`await-fresh-runtime.ts` probes every attested endpoint until one reports this checkout's
fingerprint, and exits non-zero if the base-layer deployment is stale, because waiting on the
rollup would be futile until that is fixed. `--once` prints the current state and exits.

Do not work around this by reverting the source to match the deployed build. The fingerprint
would then agree and the run would prove something about code that is not the code.

## Deploying an upgrade

Program IDs are fixed. Upgrade in place; never close and redeploy under a new ID.

```
export PATH="$PWD/.toolchain/solana/active_release/bin:$PATH"
solana program show <PROGRAM_ID> -u devnet -k .toolchain/keys/devnet-deployer.json
ls -l target/deploy/vinct_core.so
```

If the binary is larger than `Data Length`, extend first. Devnet rent is roughly 0.00000696
SOL per byte, and the extension is permanent.

```
solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES> -u devnet -k .toolchain/keys/devnet-deployer.json
```

The loader has a minimum extension: 8,192 bytes was rejected, 10,240 was accepted. `extend`
does not take `--with-compute-unit-price`.

An upgrade needs a transient buffer roughly the size of the binary, refunded on success. For
a 503 KB program that is about 3.5 SOL that must be free at the moment of deploy.

```
solana program deploy target/deploy/vinct_core.so \
  --program-id <PROGRAM_ID> -u devnet \
  -k .toolchain/keys/devnet-deployer.json \
  --upgrade-authority .toolchain/keys/devnet-deployer.json \
  --with-compute-unit-price 1000
```

If it fails partway with "N write transactions failed", the buffer is orphaned and still
holds those lamports. Find and reclaim it before retrying:

```
solana program show --buffers -u devnet -k .toolchain/keys/devnet-deployer.json
solana program close <BUFFER> -u devnet -k .toolchain/keys/devnet-deployer.json
```

`--with-compute-unit-price 1000` materially improves the odds on a congested Devnet.

### Formatting counts as a source change

`cargo fmt` changes the fingerprint. Finish every edit, then format, then build, then deploy.
Formatting after a deploy leaves the checkout ahead of the chain and the next run blocks on
`STALE_BASE`, which is the gate working but a wasted deploy.

## Account lifecycle around a commit

Any state account touched in the same instruction as `commit_and_undelegate` must be held as
an `UncheckedAccount` and written by hand.

A typed Anchor `Account` is written back automatically when the instruction ends. That
happens *after* the CPI has taken the account into the intent, and Devnet rejects it with
`ExternalAccountDataModified`. Moving your own mutation earlier does not help; the write that
fails is Anchor's, not yours (D-0025, then D-0029).

The pattern, in `vinct_core`:

1. declare the account as `UncheckedAccount` with its PDA seeds constrained
2. check the owner before interpreting any bytes
3. deserialize by hand, which also checks the discriminator
4. apply every mutation and store it back
5. only then build the intent

`gate_incident_before_leaving` and `SettlementOperation::load`/`::store` are the two places
this is done. Do not reintroduce a typed `Account` on these paths without evidence on Devnet
that it is safe.

Regression coverage: `crates/vinct-program-tests/tests/privacy.rs` for the incident paths,
`crates/vinct-program-tests/tests/adversarial.rs` for the operation account.

## Program tests run against the built artifact

`crates/vinct-program-tests` loads `target/deploy/*.so`. `cargo check` and `cargo test` do not
rebuild it. A test asserting behaviour you just added will silently exercise the previous
build until you run `anchor build --ignore-keys`, and it fails in a way that looks like the
new code is wrong.

```
anchor build --ignore-keys && cargo test -p vinct-program-tests
```

## Reading a failure on a private rollup

Two things make a PER failure quieter than an ordinary one.

ER sends skip preflight, so the error is a bare signature and the reason lives in the landed
transaction.

The permission withholds logs. VINCT grants members no visibility flags, so the rollup
correctly refuses to show transaction logs even to the wallet that sent the transaction. The
reason therefore has to come from the error code:

```json
{"InstructionError":[0,{"Custom":6014}]}
```

Resolve the code against the IDL. `scripts/phase4-per.ts` does this in
`namedInstructionError`. 6014 is `PrivateFieldsNotZeroized`.

## Selecting a rollup

Never by name. `scripts/phase4-per.ts` asks every router-advertised endpoint for a TDX quote
over a fresh 64-byte challenge and keeps the ones whose quote report data is that challenge.
On 2026-08-07 that was one of four.

Do not hardcode a region because it worked once. Phase 3's Europe workaround was a
workaround.

## Incident IDs

An incident that reaches a terminal state cannot be reopened, so a rerun needs a new one:

```
VINCT_INCIDENT_ID=6 pnpm exec tsx scripts/phase4-per.ts
```

Reusing a terminal ID fails with `IncidentAlreadyOpened`, which is the program refusing
correctly.

## What a passing run has to show

`scripts/phase4-per.ts` reports `PASS` only when all of these hold. Any one of them failing
is a `FAIL`, not a warning.

- no canary on any scanned surface
- no unreadable surface, because "could not read" is unproven rather than clean
- every refusal happened, and happened for the error it was supposed to
- every private field class was found inside the permission before the scrub, so the leak
  scan had something to find
- the account returned to base ownership with `private_fields_zeroized` set

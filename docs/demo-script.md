# Demo script

Three minutes. One claim, one thing that is hard about it, and one thing anyone watching can
check themselves afterwards.

The whole run is live against a local MagicBlock stack. Nothing is a recording and nothing is
seeded, which matters because the interesting states are the failures and a seeded demo cannot
produce them honestly.

## Before you start

```bash
bash scripts/bootstrap-local.sh stop && bash scripts/bootstrap-local.sh start
solana program deploy target/deploy/vinct_core.so --program-id .toolchain/program-keys/vinct_core-keypair.json -u http://127.0.0.1:8899 -k .toolchain/keys/devnet-deployer.json
solana program deploy target/deploy/vinct_adapter.so --program-id .toolchain/program-keys/vinct_adapter-keypair.json -u http://127.0.0.1:8899 -k .toolchain/keys/devnet-deployer.json
solana program deploy target/deploy/vinct_mock_protocol.so --program-id .toolchain/program-keys/vinct_mock_protocol-keypair.json -u http://127.0.0.1:8899 -k .toolchain/keys/devnet-deployer.json
pnpm --filter @vinct/web build
```

A stopped and restarted stack discards the ledger. Run it, because a demo layered on old state
will show a covenant nobody formed on camera.

## 0:00 the problem, in one sentence

> Three lending protocols use the same oracle. It starts printing garbage. Every one of them has
> a runbook, all three find out from Twitter, and each acts alone.

## 0:15 the covenant, formed before anything is wrong

```bash
pnpm exec tsx scripts/phase5-composition.ts
```

While it runs, the thing to say over it:

> Nobody can form this alone. The steward convenes and adds members and can do nothing else. Each
> protocol ratifies its own membership with its own signature, and then arms its own adapter.
> Two steps are permissionless, because by the time they run every signature that mattered has
> already been given.

Then, on the arming:

> What each protocol authorises is one instruction, one target account, one effect ceiling, and a
> validity window. Not "the circle can act on my behalf". The circle receives nothing.

## 1:00 the vote nobody can read

Still in the same run's output, at the sealed attestations:

> Two protocols approve. The third stays silent, and certification does not wait for it.
>
> Each ballot lives in its own account inside a private rollup, permissioned to exactly one
> reader. A co-member reading a peer's ballot is refused by the query service, not discouraged by
> convention. And no account anywhere holds a running count, so there is nothing to leak even to
> somebody who could read everything.

The run prints two approvals only after the incident is terminal. Point at that.

## 1:30 settlement, read rather than assumed

At `INTENT_ACCEPTED`:

> That signature means an intent was accepted. It does not mean anything happened.
>
> When a base action fails, the committor can strip every action from that transaction and retry
> the commit alone, so a later successful commit is not evidence that any action ran. Everything
> after this line is read back off the base layer, one effect at a time.

Ends at `ALL_ACTIONS_APPLIED`. Three markets paused, three receipts, settlement finalized.

## 2:00 the failure that matters

```bash
pnpm exec tsx scripts/phase5-composition.ts --suspend-one
```

> Same run. One protocol changes its mind after the certificate exists and suspends its
> capability.
>
> The result is `COMMIT_WITHOUT_ACTIONS`. Not two of three markets paused. Zero. One failing
> action removes the whole cohort, which is why that state is first class here and why recovery
> is a governed proposal under a new operation ID rather than a retry of the one action that
> looks missing.

This is the moment worth the most time. A partial application is the failure this design exists
to prevent, and the run shows it never happens.

## 2:30 check it yourself

```bash
pnpm verify-operation artifacts/local-stack/phase5-composition-success.json
```

> Seventeen checks. It reads the incident and the covenant off the chain and re-derives the
> operation ID from the covenant's own frozen terms, with an implementation that shares no code
> with the program. Then it confirms the certificate and every receipt carry that same ID.
>
> Delivery is reported next to the verdict and deliberately not folded into it, because a cohort
> that was scheduled and stripped has correctly bound receipts and no effects.

Then the same thing in a browser, with no wallet:

```bash
pnpm web
```

Open `/proof?operation=<the id the run printed>`.

> No wallet, no login, nothing to trust about this page. Paste an operation ID and it does the
> same seventeen checks against whatever cluster the link names.

## 2:50 close

> An incident nobody answers settles itself too. A crank does nothing while the window is open
> and settles it at the deadline, and if the whole scheduler disappears the same instruction is
> permissionless and anyone can call it.
>
> Every claim in this project is in a ledger with the commands that produced it and its
> limitations written next to it. Fifty-six of them. The audit lists eleven things we got wrong
> and the gate each one left behind.

## If something breaks on camera

Do not restart into a rehearsed path. The failure states are the product.

- A run that stops at a deadline means the response window closed. Say so and rerun.
- `no free covenant id` means the ledger has been used sixty-four times. Restart the stack.
- An unreachable RPC shows as an outage in the web app rather than an empty result. That is the
  slide about not inferring absence from silence, arriving early.

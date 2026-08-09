# Demo guide

Two to three minutes, no wallet, no local setup. Everything below is live at
<https://vinct.timjosh507.workers.dev>.

Each row is what to click and what to say over it.

## 00:00 the thesis

**Open** <https://vinct.timjosh507.workers.dev>

> Three protocols share a price feed. It breaks. Today each one has a runbook, they all find out
> from Twitter, and each acts alone.

Let the artwork sit for a beat: three lit stations on one ridge, bound by signal lines, under one
storm.

## 00:20 three protocols, one dependency

**Click** Explore live demo

> They agreed months earlier. Atlas Lending, Boreal Markets, Cinder Credit, one shared price
> feed, and a policy: pause new borrowing when two of three privately certify an incident.
>
> Each one armed its own adapter. VINCT holds no authority over any of them.

Point at the readiness column: three of three armed.

## 00:40 the private incident

**Click** through lifecycle steps 01 to 03 on the left.

> The claim goes into an account inside a private rollup that only the member set can read. Each
> member gets their own ballot account, readable by exactly one key.

## 01:05 sealed responses

**Stay on** step 03.

> Two approve. The third stays silent, and certification does not wait for it.
>
> No account anywhere holds a running count. Not a hidden one. The tally exists only inside
> certification, for the moment it runs. So there is nothing to leak even to somebody who could
> read everything.

## 01:25 certificate and bounded adapters

**Click** steps 04 to 06.

> The incident earns a certificate. There is no key that can issue one.
>
> Each protocol's own adapter reads it, checks it against bounds that protocol set before any
> incident existed, and acts. One instruction, one account, one effect ceiling.

## 01:45 it worked

**Scroll** to "Two incidents, same covenant". Stay on **Coordinated response**.

> Three markets paused. Three adapter receipts, three target effects, one settlement receipt,
> each read back off the base layer rather than inferred.

## 02:05 it did not, and VINCT says so

**Click** Nothing executed.

> Same covenant, same certificate, same scheduling transaction, which succeeded.
>
> Zero protocols acted. Not two of three. One failing action removes the entire cohort, and
> VINCT reports that instead of reporting success. Most coordination systems would have told you
> it worked.

This is the moment worth the most time.

## 02:30 check it without trusting the page

**Click** Verify this operation yourself.

> Seventeen checks against Devnet, no wallet. It reads the incident and its covenant off the
> chain and re-derives the operation identity from the covenant's own frozen terms, with an
> implementation that shares no code with the on-chain program.
>
> Delivery is reported next to the verdict and deliberately not folded into it, because a cohort
> that was scheduled and stripped has correctly bound receipts and no effects.

## Direct links

| | |
| --- | --- |
| Landing | <https://vinct.timjosh507.workers.dev> |
| Demo | <https://vinct.timjosh507.workers.dev/demo> |
| Settled proof | <https://vinct.timjosh507.workers.dev/proof/b259584f4498acbc356d1940865288b623f4049e155b73c574dad7d4d166af1a> |
| Stripped-cohort proof | <https://vinct.timjosh507.workers.dev/proof/91e8cd15e8b57279ed6ce6ab95a9614348dc8d5041ff4d7a7b79e2bfcf4bd9a1> |
| Console | <https://vinct.timjosh507.workers.dev/app> |
| Status | <https://vinct.timjosh507.workers.dev/status> |

## If something goes wrong on camera

Do not restart into a rehearsed path. The failure states are the product.

- A slow proof page is the public RPC, not an error. It resolves.
- An unreachable node shows as an outage with what breaks, not an empty result. That is the
  "never infer absence from silence" slide arriving early.

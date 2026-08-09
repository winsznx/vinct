# Privacy model

Exactly what is private, from whom, and how that is enforced.

## The boundary

| | Public | Member set | That member alone |
| --- | --- | --- | --- |
| Incident exists | yes | | |
| Threshold, window, policy | yes | | |
| Terminal outcome and final counts | yes | | |
| Settlement evidence | yes | | |
| The claim and its evidence | | yes | |
| One member's decision | | | yes |

An incident's existence is public by design. Its contents are not.

## What a member can and cannot see

Member A can read the claim, because A is in the member set. A can read A's own ballot, because
it is A's.

A **cannot** read B's ballot. Not the decision, not whether B has answered, not when. Neither can
the opener, the steward, or the public.

This is not a UI decision. Each ballot is a separate account with its own `EphemeralPermission`
naming exactly one reader, and the query-filtering service refuses the read.

## No live tally exists

While an incident collects, **no account anywhere holds a count**. Not a hidden one, not an
encrypted one. Certification reads the ballots into memory, counts, and writes only the final
totals, only once the incident is terminal.

So there is nothing to leak even to somebody who could read everything. The interface says this
rather than silently omitting a number, because a missing count looks like one that failed to
load, and "hidden" and "does not exist" are different claims.

## Account existence reveals nothing

Every ballot account is created before the incident opens, for every member, whether or not they
ever answer. An account that appeared on first vote would announce that somebody had voted, which
is the same fact a live tally would leak in a different shape.

Silence costs nothing: a member who does not answer does not delay the outcome, and their
silence is not visible either.

## Rejection is named at the deadline

A rejected incident is settled at its deadline, never the moment the blocking rejection lands.
Settling early would announce exactly when that happened. Before the deadline every
non-terminal certification refuses identically with `IncidentNotTerminal`, whatever the reason.

## Erasure

When an incident ends, the claim and every ballot are overwritten before the accounts leave the
rollup. The program refuses to release them otherwise, checking both the zeroization flag **and**
that the protected bytes are actually zero. A flag set without a scrub passes the first and fails
the second.

The leak scan has a positive control: it requires every canary to be present inside the
permission before the scrub, so a scan that found nothing because it was looking in the wrong
place fails instead of passing.

## The platform property this rests on

Program execution authorization and query visibility are **separate** in the current PER flow. A
member can submit a transaction that causes the program to read and mutate accounts that member
cannot itself read over RPC.

That was established by experiment, not assumed, and it is what makes the split-account design
work at all. The claim is deliberately narrow: it describes the tested VINCT account flow on the
current MagicBlock runtime and should not be generalised further. See `docs/decision-log.md`
D-0042.

## In the browser

The deployed app persists one storage key, holding a wallet's name so a reload can reconnect
silently. Never a key, never a token, never anything about an incident.

A rollup session token lives in memory for the tab and is never written down. The private read
path runs from the browser straight to MagicBlock over a wallet-authenticated connection; it does
not pass through Cloudflare or any server this project operates.

Browser tests assert that no route persists anything matching a decision, claim, ballot, or
nonce, that no surface renders a live tally, and that the app contacts no host the reader did not
choose.

## Not claimed

Constant-time behaviour. Traffic-analysis resistance. Concealment of an incident's existence.
Protection against a member who chooses to publish their own decision. Cryptographic proof of
which workload runs inside the TEE.

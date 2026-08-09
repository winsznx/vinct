# Security model

What VINCT can and cannot do, where the trust boundaries sit, and the failure modes that turned
out to matter. The interesting failures are kept in rather than sanitised away, because they are
what the design is shaped around.

## The central claim

**VINCT never receives authority over any protocol.** There is no instruction that gives the
circle, the steward, or any VINCT program the ability to act on a member's contracts.

A certificate is a published fact. It carries no authority and grants none. An adapter reads it,
checks it against bounds its own protocol set before any incident existed, and decides.

## Trust boundaries

| Boundary | Trusted with | Not trusted with |
| --- | --- | --- |
| Steward | convening, naming candidates | consenting for anybody, arming anything |
| A member | its own membership, its own adapter, its own ballot | any other member's anything |
| VINCT programs | deriving identity, counting a tally in memory | acting on a protocol |
| MagicBlock rollup | isolating private accounts, executing delegated state | being the source of settlement truth |
| Cloudflare Worker | serving files, forwarding read RPC | authority, keys, private material, truth |
| The browser | building and displaying | holding any secret |

## What an adapter revalidates

Every one of these, on every execution, before any CPI:

- covenant, circle epoch, policy ID, member set hash, cluster genesis hash
- certificate account re-derived from the operation ID, so a supplied address cannot be swapped
- certificate expiry against the current slot
- the action template hash, rebuilt from the live account list rather than trusted
- the instruction data hash
- the effect ceiling: may pause, may unpause, maximum value moved
- armed, and not suspended
- the validity window
- replay, via a receipt seeded by the operation ID

A certificate that satisfies none of a protocol's own bounds does nothing at all.

## Findings that shaped the design

These were found during implementation. Each is fixed, and each left a gate behind.

### Execution authorization is not query authorization

A PER permission that lets a member interact with an account also lets them read it. That single
fact rules out any shared account holding a tally, and is why state is split into a public core,
a claim private to the member set, and one ballot per member. Established by experiment rather
than assumed. See D-0035 and D-0042.

### Stale ER executable

A rollup caches a program's executable the first time it runs it, and a base-layer upgrade does
not evict that cache. The account clone stays perfectly current, so everything looks deployed
while the rollup runs the previous binary.

A member submitting into that would sign for logic nobody deployed. The frontend checks a build
fingerprint before offering any write and refuses rather than warns. See D-0030, D-0040.

### Anchor typed write-back after undelegation

Anchor's automatic account write-back lands *after* `commit_and_undelegate` has taken the
account, and Devnet rejects it as `ExternalAccountDataModified`. Every exit path holds its
accounts as `UncheckedAccount` and decodes by hand. See D-0029.

### Magic Action stripping

A failing BaseAction can cause the committor to remove **every** BaseAction in that transaction
strategy and retry the remaining commit work. Two separate causes were run on Devnet and both
produced zero effects, not two of three.

So `COMMIT_WITHOUT_ACTIONS` is a first-class state, every effect is observed independently, and
recovery replaces the cohort under a new operation ID rather than retrying the action that
appears missing. See D-0053.

### Dispatcher-injected accounts

`#[action]` appends an escrow pair the adapter never reads. They are excluded from the template
commitment deliberately, which is what lets one arming serve both a direct call and a scheduled
action. An extra account is inert and does not change the committed hash, which is tested.

### Decoder drift

A drifted decoder does not fail. It reads the wrong offsets and returns numbers that look like
numbers: two approvals were once reported as fifty, and the run printed PASS. Every
evidence-producing decoder is now pinned to a vector generated from the program's own Rust
struct and fails closed on discriminator, length, and version. See D-0051, D-0052.

Worse, the vectors themselves went stale once: `ActionTemplateV1` gained six fields and nobody
regenerated, so both languages agreed with each other and neither agreed with the program.
`pnpm check-vectors` makes that a failing build. See D-0055.

### Crank asynchrony

A schedule transaction's success means the request was accepted. The validator's own log says
`Scheduled task request`. Registration and execution are separate observations.

The scheduler takes the signer of the schedule request as the task's authority and silently
drops a cancel from anyone else, so both transactions succeed and the task keeps running.
Requesting and cancelling are both signed by the opener. See D-0060.

Removal is established by absence over a quiet window with iteration exhaustion excluded,
because a task that ran out of iterations also stops. Reporting exhaustion as a successful
cancellation was a real bug. See D-0061.

### Authorization holes found in review

A permission instruction with no signer check let any wallet add itself as a reader of a live
incident. A delegation instruction never checked its signer against the account being delegated,
so a stranger could choose which rollup another incident's private material landed on. See
D-0039, D-0041.

Certification could also be handed a ballot set the incident never had: an opener could create
four ballots, open with three, and supply a different three. Fixed by computing the member-set
commitment on chain at open and reconstructing the set at certification. See D-0044.

## Key material

No secret key exists anywhere in the deployed application. Not in source, environment variables,
`localStorage`, `sessionStorage`, `IndexedDB`, or a Cloudflare binding.

Every signature is produced in the user's wallet. The rollup session token is a bearer
credential for a member's private view and is held in memory only: persisting it would leave it
readable by anything else on the origin and alive after the tab closed.

## What is not claimed

TEE attestation establishes a genuine TDX quote bound to a fresh challenge, from hardware
Intel's chain vouches for. It does **not** compare MRTD or RTMR against an expected workload, so
it does not establish which code runs inside the enclave.

Nothing here establishes constant-time behaviour, traffic-analysis resistance, or concealment of
an incident's existence. An incident's existence is public by design.

The threat model does not cover a malicious rollup operator with a fabricated attestation, a
compromised protocol authority key, or collusion among a threshold of members. A covenant that
reaches its threshold is by construction a covenant whose members agreed.

---

**Next:** [PRIVACY_MODEL.md](PRIVACY_MODEL.md) for the read boundary in detail,
[audit-report.md](audit-report.md) for the findings that produced these gates,
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for what is still unproven, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the structure being defended.
[Back to the README](../README.md).

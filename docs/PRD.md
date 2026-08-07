# VINCT Product Requirements Document

Version: 1.0  
Status: Product lock and implementation handoff  
Prepared: 2026-08-03  
Product: VINCT  
Tagline: Binding mutual aid for protocols  
Hackathon: Solana Blitz V7, MagicBlock  
Primary implementation agent: Claude Code

## 0. Document authority

This document is the product and implementation source of truth until executable evidence disproves an assumption.

Claude Code must not silently redesign the product, broaden scope, replace MagicBlock primitives with mocks, or treat an ER signature as proof that base-layer actions completed. When implementation evidence conflicts with this PRD:

1. Record the evidence in `docs/decision-log.md`.
2. Mark the affected claim in `docs/claim-ledger.json`.
3. Stop the current phase.
4. Propose the smallest correction that preserves the dominant mechanism.
5. Continue only after the correction is accepted.

The first objective is not a dashboard. It is one real, inspectable lifecycle that proves the mechanism through the current MagicBlock stack.

---

# 1. Executive summary

VINCT lets protocols that share a critical dependency form a binding mutual-aid covenant without surrendering general administrative control.

Each protocol installs and owns a sovereign adapter. The adapter permits one narrow emergency action, such as pausing new borrowing, under limits chosen by that protocol. The circle itself never receives an unrestricted admin key.

When an incident occurs, authorized responders submit private incident claims and sealed attestations inside a Private Ephemeral Rollup. The private state machine evaluates a frozen policy and, when the required threshold is reached, emits a certificate tied to one exact action bundle. Magic Actions schedules the certificate commit and the registered base-layer actions.

VINCT marks an incident settled only after it independently observes every required base-layer effect. Magic Actions gives per-attempt atomicity for the commit and actions, but a failed BaseAction may cause the committor to remove that strategy's BaseActions and retry the remaining commit work. Therefore `COMMIT_WITHOUT_ACTIONS` is a first-class recovery state, not an edge case.

The hackathon proof uses three reference protocols and three protocol-owned sovereign adapters. It demonstrates:

- three protocol teams ratifying a covenant
- private incident evidence and sealed attestations
- a threshold certificate bound to one exact action bundle
- three bounded protocol actions attempted together
- independent verification of every required effect
- action failure and the exact recovery state produced by current Magic Actions behavior
- no public incident evidence, ballot identity, or live quorum count

---

# 2. Product lock

## 2.1 One sentence

VINCT is a private covenant and settlement system that lets independent protocols pre-agree on bounded mutual-aid actions, privately certify a shared incident, and coordinate protocol-owned emergency adapters through MagicBlock.

## 2.2 Dominant mechanism

```text
private incident claims and sealed member attestations
    -> policy evaluation inside PER
    -> one incident certificate bound to one exact action bundle
    -> Magic Actions schedules the base-layer cohort
    -> an independent reconciler verifies every required protocol effect
```

## 2.3 Winning thesis

Protocols that share infrastructure should be able to prepare together before a crisis, attest without revealing sensitive evidence or individual positions, and execute their own narrowly bounded safeguards from one certified outcome.

## 2.4 Why MagicBlock is load-bearing

Private Ephemeral Rollup:

- protects incident claims, attestations, and threshold evaluation from unauthorized public reads
- enables a shared private state machine between independent protocols
- creates an access-controlled interaction surface without moving general protocol authority into the circle

Ephemeral Rollup:

- supports the rapid multi-party formation and incident workflow
- keeps the delegated incident account writable through one router-resolved ER
- hosts the private state machine and terminal scrub-before-commit lifecycle

Magic Actions:

- connects the certified ER outcome to base-layer protocol actions
- removes the need for each protocol team to manually construct a separate transaction after seeing the result
- provides atomicity within each attempted base-layer transaction
- exposes a real delivery and reconciliation problem that VINCT handles honestly

Cranks:

- expire stale incidents and close denial-of-service windows
- are asynchronous, so acceptance, scheduler registration, iteration, and desired state are tracked separately

No VRF, token, payment, reputation, AI agent, governance token, or cross-chain feature belongs in the core build.

---

# 3. Falsifiable core claim

Given:

- a ratified three-member covenant
- a frozen incident member snapshot
- a private incident claim
- a policy requiring two valid approvals
- three protocol-owned sovereign adapters
- one domain-separated canonical action bundle
- a valid MagicBlock deployment and router-resolved ER endpoint

VINCT must:

1. accept incident submissions only from authorized members
2. prevent unauthorized clients from reading protected incident content, individual decisions, or exact live quorum progress
3. count at most one effective attestation per eligible member and incident version
4. evaluate the frozen policy without lowering the threshold when a member is quarantined
5. bind the certificate to the exact cluster, circle epoch, incident ID, policy, member snapshot, adapter versions, account order, instruction data, limits, expiry, and nonces
6. zeroize private fields before any account data commits to the public base layer
7. schedule the certificate and required base-layer actions through the current Magic Actions interface
8. observe the actual base-layer transaction and every required protocol effect before marking the incident settled
9. detect a commit that lands without the originally scheduled actions
10. prevent replay of attestations, certificates, adapters, and recovery operations
11. expire incomplete incidents through a verified crank or explicit permissionless expiry instruction
12. produce read-only evidence that a judge can inspect without trusting the UI

The claim is falsified if any of these occur:

- protected incident bytes appear in public account state, logs, messages, browser persistence, telemetry, or downloadable artifacts
- an unauthorized or stale member contributes to quorum
- a member contributes more than once
- quarantine lowers the original threshold
- reordered account metas or modified instruction bytes produce the same action-bundle hash
- an adapter accepts arbitrary CPI or broader authority than its declared capability
- an ER scheduling signature is presented as final settlement
- a successful incident certificate is presented as proof that adapters ran
- VINCT reports `SETTLED` while any required adapter effect or receipt is missing
- a previous incident's attestation or certificate can satisfy a new incident
- a failed action can be naively replayed without a new recovery operation and reconciliation proof
- private fields remain in the delegated account at commit or undelegation
- a stale incident remains open indefinitely
- the live implementation differs from the executable reference model

---

# 4. Headline proof

The target submission claim is:

> Three protocol teams ratified one machine-enforceable mutual-aid covenant. Two sealed incident attestations produced one certificate. VINCT scheduled three protocol-owned emergency actions through Magic Actions and independently verified which effects reached Solana. No incident evidence, ballot identity, or exact live quorum count became public.

Two outcomes must be demonstrated.

## 4.1 Successful cohort

```text
3 covenant members
2 private approvals
1 certificate
3 required adapter effects observed
1 final settlement receipt observed
0 protected fields public
```

## 4.2 Failed action and recovery classification

```text
1 adapter deliberately fails
the attempted base transaction reverts
if the committor later commits without the actions:
    VINCT detects COMMIT_WITHOUT_ACTIONS
    VINCT does not mark the incident settled
    no independent action retry occurs
    a new recovery operation is required
```

Do not claim whole-workflow all-or-nothing finality until the target environment proves that every required action remains in one transaction strategy and the final observed base transaction contains the full cohort.

---

# 5. Users and product modes

## 5.1 Primary users

Initial operator:

- protocol security engineer or risk lead who owns an emergency runbook
- has authority to propose a bounded adapter
- can run a tabletop drill
- can coordinate with the protocol multisig or governance process

Circle steward:

- oracle, bridge, ecosystem foundation, audit firm, incident-response network, or protocol suite
- already has relationships with several affected protocols
- provides covenant templates and drill coordination
- never receives general protocol authority

Protocol authority:

- the wallet, multisig, or governance authority that installs, arms, suspends, renews, and removes the sovereign adapter

Responder:

- an authorized member key that may open an incident and submit one sealed attestation

Observer:

- can see high-level lifecycle status and final evidence
- cannot vote
- cannot see protected content, member decisions, or exact live quorum progress

Reconciler:

- reads base-layer state and action receipts
- classifies action delivery
- cannot manufacture settlement
- initiates a governed recovery proposal when delivery is incomplete

## 5.2 Mode 1: Simulate

One protocol can:

- create a local covenant template
- install unarmed adapters
- run incident drills
- benchmark compute and account limits
- test failure and recovery
- produce a response-readiness report

This removes the three-organization cold start for the first useful session.

## 5.3 Mode 2: Internal circuit

One organization coordinates several internal roles or several programs:

- security
- risk
- governance signer
- operations
- protocol programs or markets

The same private certification mechanism applies without requiring external adoption.

## 5.4 Mode 3: Mutual-aid circle

Several independent protocols sharing one dependency ratify a covenant and arm bounded adapters.

This is the flagship product and hackathon demonstration.

---

# 6. Goals, success metrics, and non-goals

## 6.1 Product goals

- make pre-incident collaboration explicit and inspectable
- preserve protocol sovereignty
- keep incident content and individual decisions private from unauthorized observers
- bind certification to a deterministic action bundle
- use PER, ER, Magic Actions, and crank behavior correctly
- provide honest settlement and recovery semantics
- make the central proof understandable in under thirty seconds
- let a judge verify the result in under two minutes
- leave a credible path from reference adapters to real protocol integrations

## 6.2 Hackathon success metrics

Required:

- three reference protocols deployed
- three sovereign adapters installed
- one covenant ratified on the target network
- one private incident lifecycle executed through a TEE-backed PER environment
- one successful action cohort with all required effects independently observed
- one deliberate action failure
- `COMMIT_WITHOUT_ACTIONS` detection verified if the committor exhibits that path
- one replay attempt rejected
- one unauthorized private read rejected
- one stale incident expired
- one canonical action hash mutation test artifact
- exact per-action and total transaction compute measurements retained
- one public proof page and read-only verifier
- one completed artifact and one resettable demo artifact

Aspirational:

- one real security operator reviews the sovereign adapter model
- one external test wallet participates
- one real protocol or multisig adapter spike begins after the reference cohort passes

## 6.3 Non-goals

The hackathon build will not:

- claim production security
- control real protocol administrator keys
- integrate arbitrary production protocols without permission
- move treasury assets
- freeze withdrawals
- support arbitrary CPI
- diagnose exploits automatically
- use AI to decide whether an incident is real
- provide insurance
- hide incident existence or traffic patterns
- guarantee secrecy against a compromised TEE
- guarantee exact crank wall-clock execution
- guarantee Magic Action delivery from scheduling alone
- implement cross-chain response
- add a token, marketplace, reputation score, governance system, or social feed
- depend on seeded activity presented as real adoption

---

# 7. Product experience

## 7.1 Covenant formation

1. A steward creates a formation room.
2. Protocol teams join through wallet authentication.
3. The room proposes:
   - covered dependency
   - eligible members
   - response action category
   - adapter manifest
   - threshold
   - veto or maximum rejection rule
   - response window
   - certificate lifetime
   - covenant expiry
4. Each protocol reviews its own adapter capability.
5. Each protocol authority signs the exact covenant digest.
6. The base-layer `Covenant` account becomes `RATIFIED`.
7. Each adapter remains `UNARMED` until its protocol authority separately arms it.
8. The circle becomes `ARMED` only when every required adapter is armed and versions match.

Visible result:

```text
Covenant ratified
3 members
3 sovereign adapters
0 external admin keys
Expires at slot N
```

## 7.2 Incident opening

1. An active responder selects a covered dependency and action category.
2. The client submits the private claim to the router-resolved PER endpoint.
3. The program verifies:
   - circle status
   - member status
   - policy status
   - incident uniqueness
   - rate limit
   - action bundle version
4. The incident snapshots:
   - circle epoch
   - member-set hash
   - policy hash
   - adapter versions
   - threshold
   - expiry
5. The incident enters `COLLECTING`.
6. A crank-expiry task is requested.
7. The UI displays only `Incident active` and the deadline to observers.

## 7.3 Sealed attestation

1. A member submits `APPROVE`, `REJECT`, or `ABSTAIN` privately.
2. The program authenticates the member and nonce.
3. One current attestation per member is stored.
4. Other members cannot query the decision or exact current count.
5. The member receives a uniform acknowledgement.
6. When the frozen threshold is met:
   - private fields are zeroized
   - the public certificate fields are finalized
   - incident state becomes `CERTIFIED_PENDING_SETTLEMENT`
   - the Magic Intent bundle is built

No all-member reveal phase is used because it would turn a k-of-n threshold into an n-of-n liveness dependency.

## 7.4 Settlement

1. VINCT builds one intent bundle with:
   - scrubbed incident account commit
   - certificate or public checkpoint commit
   - registered BaseActions in covenant order
   - final settlement-receipt action
2. The ER transaction submits the intent.
3. The UI becomes `SETTLING`.
4. The settlement monitor records:
   - ER signature
   - commitment or base transaction signature
   - action list expected
   - action effects observed
   - final receipt observed
5. `SETTLED` is allowed only when every required effect and the final receipt are observed.
6. If the scrubbed certificate commits but action effects are absent:
   - state becomes `COMMIT_WITHOUT_ACTIONS`
   - an alert and reconciliation case are created
   - the original action nonce remains consumed
   - an independent blind retry is prohibited

## 7.5 Expiry

1. The crank or permissionless expiry handler runs after the incident deadline.
2. The handler is monotonic and idempotent.
3. If the incident is still incomplete:
   - private fields are zeroized
   - certificate fields remain absent
   - state becomes `EXPIRED`
4. The scheduler registration and actual state transition are observed separately.
5. The private account is committed or safely undelegated only after the scrubbed state is verified.

## 7.6 Reconciliation

1. The reconciler reads all expected base-layer effects.
2. It classifies:
   - `ALL_ACTIONS_APPLIED`
   - `NO_ACTIONS_APPLIED`
   - `PARTIAL_OBSERVATION`
   - `UNKNOWN`
3. `PARTIAL_OBSERVATION` is treated as a critical invariant failure because one intended cohort should share one transaction outcome.
4. A recovery proposal contains:
   - original operation ID
   - original certificate hash
   - observed base state
   - missing effects
   - new recovery nonce
   - new expiry
   - required human approvals
5. Recovery uses a new operation ID. It never reuses the original certificate nonce.

---

# 8. System architecture

## 8.1 Architecture decision

Use PER for protected incident state and sealed threshold evaluation. Keep covenant authority, adapter manifests, protocol state, and settlement receipts on Solana base layer. Use Magic Actions for commit-linked base-layer actions. Treat action delivery as asynchronous and independently reconciled. Use cranks only for incident expiry and terminal maintenance.

## 8.2 Programs

### `vinct_core`

Base and ER-compatible Anchor program.

Responsibilities:

- covenant creation and ratification
- member and policy registry
- incident account creation
- delegation and terminal lifecycle
- sealed attestation state machine
- private-field zeroization
- certificate generation
- Magic Intent bundle construction
- settlement receipt finalization
- recovery operation registry
- replay protection

Required attributes and SDK surfaces:

- `#[ephemeral]` before `#[program]`
- `#[delegate]` for delegation context
- `#[commit]` for commit contexts
- `MagicIntentBundleBuilder`
- PER access-control feature and ER-local permission CPI

### `vinct_adapter`

Reference sovereign adapter program.

Responsibilities:

- store protocol-owned capability
- arm, suspend, renew, and revoke capability
- validate VINCT certificate
- validate exact action manifest
- validate effect limit
- validate adapter version and operation nonce
- call one reference protocol instruction
- write an adapter execution receipt

It must not:

- accept arbitrary target programs
- accept arbitrary instruction bytes
- infer account order from a sorted list
- trust a UI-provided threshold
- let the circle change adapter limits
- expose an unrestricted forwarding instruction

### `vinct_mock_protocol`

Three instances or three state accounts representing independent protocols.

Required action:

- `pause_new_borrowing`

Required state:

```rust
pub struct ProtocolMarket {
    pub authority: Pubkey,
    pub adapter: Pubkey,
    pub new_borrowing_paused: bool,
    pub last_operation_id: [u8; 32],
    pub update_count: u64,
}
```

The mock protocol must enforce that only its adapter may call the pause instruction.

### `vinct_verifier`

May be a read-only TypeScript package rather than an on-chain program.

Responsibilities:

- reconstruct covenant digest
- reconstruct action-bundle hash
- read member snapshot and policy
- read certificate
- read adapter manifests and receipts
- read protocol states
- classify settlement
- output machine-readable verification JSON

## 8.3 Services

### Web application

- covenant formation
- adapter inspection
- private incident room
- sealed attestation flow
- observer status
- settlement monitor
- proof page
- resettable demo

### Settlement watcher

- router-aware and cluster-aware
- polls base state and transaction status
- never stores private incident payloads
- writes only derived public reconciliation records
- creates alerts for timeout or missing action effects

It is not an execution authority.

### Optional drill orchestrator

After the core proof:

- resets reference protocols
- funds test accounts
- creates deterministic demo fixtures
- labels them as test fixtures

---

# 9. Account and authority model

| Logical account | Owner | Derivation | Created on | Persistence | Delegated | Authority | Privacy | Terminal policy |
|---|---|---|---|---|---|---|---|---|
| `covenant` | `vinct_core` | PDA `["covenant", steward, covenant_id]` | base | durable | no | ratification authorities | public | expire or supersede |
| `covenant_member` | `vinct_core` | PDA `["member", covenant, protocol]` | base | durable | no | protocol authority | public | deactivate for future epochs |
| `response_policy` | `vinct_core` | PDA `["policy", covenant, policy_id]` | base | durable | no | covenant ratification | public | version through new epoch |
| `incident_state` | `vinct_core` | PDA `["incident", covenant, incident_id]` | base then PER | durable scrubbed checkpoint | yes | program plus permission authority | private while active | zeroize, commit, undelegate |
| `ephemeral_permission` | MagicBlock permission program | SDK-defined | ER | ER-local | no separate base delegation | trusted permission authority | private ACL | close before terminal cleanup |
| `adapter_capability` | `vinct_adapter` | PDA `["capability", protocol, covenant, policy]` | base | durable | no | protocol authority | public | suspend, expire, revoke |
| `adapter_receipt` | `vinct_adapter` | PDA `["adapter_receipt", operation_id, adapter]` | base action | durable | no | adapter program | public | immutable |
| `settlement_receipt` | `vinct_core` | PDA `["settlement", operation_id]` | base action | durable | no | action handler | public | immutable |
| `protocol_market_a/b/c` | `vinct_mock_protocol` | PDA per protocol | base | durable | no | local protocol authority and adapter | public | reset only in labelled demo mode |
| `recovery_operation` | `vinct_core` | PDA `["recovery", original_operation, recovery_nonce]` | base | durable | no | governed recovery authority | public | immutable outcome |

## 9.1 Private incident account layout

The active delegated account may contain protected fields while inside PER. Before any commit or undelegation, the program must zeroize every protected field.

```rust
pub struct IncidentState {
    // Public after terminal scrub
    pub covenant: Pubkey,
    pub circle_epoch: u64,
    pub incident_id: u64,
    pub status: IncidentStatus,
    pub policy_hash: [u8; 32],
    pub member_set_hash: [u8; 32],
    pub action_bundle_hash: [u8; 32],
    pub opened_at_slot: u64,
    pub expires_at_slot: u64,
    pub operation_id: [u8; 32],
    pub approval_count_after_terminal: u8,
    pub rejection_count_after_terminal: u8,
    pub certificate_hash: [u8; 32],

    // Protected while active, zeroized before commit
    pub private_claim: ZeroizableBytes,
    pub private_attestations: Vec<PrivateAttestation>,
    pub private_observation_window: PrivateObservationWindow,
    pub private_notes: ZeroizableBytes,

    pub private_fields_zeroized: bool,
    pub bump: u8,
}
```

The program must reject commit and undelegation unless `private_fields_zeroized == true`.

---

# 10. Transaction routing

| Flow | Actor | Destination | Writable accounts | Success evidence | Failure path |
|---|---|---|---|---|---|
| create covenant | steward | base RPC | covenant, policies | base signature and decoded state | retry with idempotent ID |
| ratify covenant | protocol authority | base RPC | covenant/member | threshold signatures recorded | remain draft |
| install adapter | protocol authority | base RPC | capability, protocol state | adapter manifest and ownership | unarmed |
| arm adapter | protocol authority | base RPC | capability | current version armed | remain unarmed |
| create incident account | responder | base RPC | incident | account initialized | no incident |
| delegate incident | responder or sponsor | base RPC | incident, delegation accounts | base owner plus router status | retry and inspect routing |
| create PER permission | permission authority | router-resolved ER | ER-local permission | permission state read through ER | revoke and recreate |
| open incident | responder | router-resolved PER | incident | private state status | reject or retry |
| submit attestation | member | router-resolved PER | incident | uniform acknowledgement | no quorum contribution |
| schedule expiry crank | covenant PDA or authority | ER | scheduler state plus incident | request accepted then registration observed | manual expiry remains available |
| certify and schedule actions | program/PDA | ER | incident and intent accounts | ER signature means intent accepted only | settlement monitor starts |
| observe settlement | watcher | base RPC | read-only | base tx plus every effect and receipt | classify incomplete |
| cancel crank | authority | ER | scheduler task | request accepted then removal observed | task remains active |
| undelegate scrubbed incident | authority | ER | incident | base owner restored and scrubbed bytes verified | manual recovery |

Never hardcode a regional ER endpoint. Resolve `getDelegationStatus` and use the returned `fqdn`.

Never reuse a base-layer blockhash for an ER transaction.

---

# 11. State machines

## 11.1 Covenant

```text
DRAFT
  -> NEGOTIATING
  -> RATIFIED
  -> ARMED
  -> SUSPENDED
  -> EXPIRED

RATIFIED -> SUPERSEDED
ARMED -> SUPERSEDED
```

Rules:

- `RATIFIED` requires the configured ratification authorities.
- `ARMED` requires every required adapter version to be armed.
- membership and policy changes create a new epoch.
- active incidents retain their frozen epoch.
- no mutation to an old epoch is allowed after supersession.

## 11.2 Incident

```text
DRAFT
  -> OPEN
  -> COLLECTING
  -> CERTIFIED_PENDING_SETTLEMENT
  -> SETTLING
       -> SETTLED
       -> COMMIT_WITHOUT_ACTIONS
       -> RECONCILIATION_REQUIRED
       -> SETTLEMENT_UNKNOWN

OPEN/COLLECTING -> EXPIRED
OPEN/COLLECTING -> ABORTED
```

Rules:

- no private payload remains after terminal scrub
- `SETTLED` requires observed action receipts, target effects, and final settlement receipt
- `COMMIT_WITHOUT_ACTIONS` means public certificate or scrubbed state committed but none of the required action effects were observed
- `RECONCILIATION_REQUIRED` means an incomplete or conflicting observation requires human review
- `SETTLEMENT_UNKNOWN` means provider or RPC evidence is insufficient, not that execution failed

## 11.3 Attestation

```text
NONE -> SUBMITTED -> SUPERSEDED
NONE -> SUBMITTED -> INVALIDATED_BY_QUARANTINE
```

One effective attestation per member per incident version.

A new valid submission may replace the member's earlier decision before certification. It consumes a new nonce and keeps a hash-linked audit record inside the private state until terminal zeroization.

## 11.4 Adapter

```text
INSTALLED -> UNARMED -> ARMED -> SUSPENDED -> REVOKED
                              -> EXPIRED
```

Only the protocol authority controls these transitions.

## 11.5 Action delivery

```text
EXPECTED
  -> SCHEDULED
  -> ATTEMPT_OBSERVED
       -> APPLIED
       -> REVERTED
       -> REMOVED_BEFORE_RETRY
       -> UNKNOWN
```

Settlement is a reduction over every expected action plus the final receipt.

## 11.6 Crank

```text
REQUESTED
  -> REGISTRATION_OBSERVED
  -> ITERATION_OBSERVED
  -> DESIRED_STATE_REACHED
  -> CANCELLATION_REQUESTED
  -> REMOVAL_OBSERVED
```

A successful schedule or cancel transaction is not the terminal state.

---

# 12. Canonical hashes

## 12.1 General requirements

- SHA-256
- Borsh serialization
- versioned structs
- explicit domain separator
- exact account order preserved
- no JSON canonicalization
- no string concatenation
- no client-only hash logic
- one Rust implementation is authoritative
- TypeScript verifier must consume generated test vectors

## 12.2 Covenant digest

```rust
pub struct CovenantDigestV1 {
    pub domain: [u8; 32], // sha256("VINCT_COVENANT_V1")
    pub cluster_genesis_hash: [u8; 32],
    pub covenant: Pubkey,
    pub circle_epoch: u64,
    pub steward: Pubkey,
    pub member_set_hash: [u8; 32],
    pub policies_hash: [u8; 32],
    pub adapter_set_hash: [u8; 32],
    pub valid_from_slot: u64,
    pub expires_at_slot: u64,
}
```

## 12.3 Action bundle digest

```rust
pub struct ActionBundleV1 {
    pub domain: [u8; 32], // sha256("VINCT_ACTION_BUNDLE_V1")
    pub cluster_genesis_hash: [u8; 32],
    pub covenant: Pubkey,
    pub circle_epoch: u64,
    pub incident_id: u64,
    pub policy_id: [u8; 32],
    pub member_set_hash: [u8; 32],
    pub bundle_expiry_slot: u64,
    pub operation_id: [u8; 32],
    pub actions: Vec<CanonicalActionV1>, // covenant registration order
}

pub struct CanonicalActionV1 {
    pub action_index: u16,
    pub adapter_program_id: Pubkey,
    pub adapter_version: u16,
    pub adapter_capability: Pubkey,
    pub target_program_id: Pubkey,
    pub instruction_discriminator: [u8; 8],
    pub account_metas: Vec<CanonicalAccountMetaV1>, // exact instruction order
    pub instruction_data: Vec<u8>,
    pub effect_limit: EffectLimitV1,
    pub capability_nonce: u64,
}

pub struct CanonicalAccountMetaV1 {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}
```

Account metas must never be sorted. Solana instruction order is semantic.

## 12.4 Operation ID

> **Corrected in Phase 1. See `docs/decision-log.md` D-0012.**
>
> The derivation below is circular and cannot be implemented. It takes
> `action_bundle_hash` as an input, while section 12.3 places `operation_id` inside
> `ActionBundleV1`. The loop closes a second time through the accounts: receipt PDAs are
> seeded by the operation ID (section 9) and appear in the bundle's account metas.
>
> The implemented derivation substitutes the policy's registered action-*template* hash,
> which is fixed before any incident opens:
>
> ```text
> operation_id =
> sha256(
>   sha256("VINCT_OPERATION_V1") ||
>   cluster_genesis_hash ||
>   covenant ||
>   circle_epoch_le64 ||
>   incident_id_le64 ||
>   policy_id ||
>   member_set_hash ||
>   action_bundle_template_hash ||
>   certificate_nonce_le64
> )
> ```
>
> Binding to the concrete per-incident bundle is not lost. It moves one level up, onto
> `CertificateV1.action_bundle_hash`, which section 14's adapter validation checks
> alongside the operation ID. `ActionBundleV1` keeps its `operation_id` field unchanged.

Original, superseded:

```text
operation_id =
sha256(
  "VINCT_OPERATION_V1" ||
  cluster_genesis_hash ||
  covenant ||
  circle_epoch ||
  incident_id ||
  policy_id ||
  action_bundle_hash ||
  certificate_nonce
)
```

## 12.5 Required mutation tests

Every one-byte or one-order mutation below must change the hash or fail decoding:

- cluster genesis hash
- circle epoch
- incident ID
- policy ID
- member-set hash
- action order
- account order
- account key
- signer flag
- writable flag
- instruction discriminator
- instruction data
- effect limit
- adapter version
- capability nonce
- bundle expiry
- trailing bytes
- duplicate action index

---

# 13. Policy model

```rust
pub struct ResponsePolicy {
    pub policy_id: [u8; 32],
    pub action_category: ActionCategory,
    pub eligible_member_set_hash: [u8; 32],
    pub required_approvals: u8,
    pub maximum_rejections: u8,
    pub required_roles: Vec<MemberRole>,
    pub response_window_slots: u64,
    pub certificate_ttl_slots: u64,
    pub action_bundle_hash: [u8; 32],
    pub version: u16,
}
```

Hackathon policy:

```text
action category: PAUSE_NEW_BORROWING
members: A, B, C
required approvals: 2
maximum rejections: 1
response window: short demo-safe window
certificate lifetime: one settlement attempt window
```

High-blast-radius actions are prohibited.

---

# 14. Sovereign capability model

```rust
pub struct SovereignCapability {
    pub protocol_authority: Pubkey,
    pub protocol_state: Pubkey,
    pub adapter_program: Pubkey,
    pub adapter_version: u16,

    pub covenant: Pubkey,
    pub circle_epoch: u64,
    pub policy_id: [u8; 32],

    pub action_category: ActionCategory,
    pub target_program: Pubkey,
    pub instruction_discriminator: [u8; 8],
    pub ordered_account_metas_hash: [u8; 32],
    pub instruction_data_hash: [u8; 32],

    pub max_effect: EffectLimitV1,
    pub valid_from_slot: u64,
    pub expires_at_slot: u64,

    pub armed: bool,
    pub suspended: bool,
    pub capability_nonce: u64,
    pub last_operation_id: [u8; 32],
}
```

Adapter validation order:

1. expected VINCT core program
2. expected certificate account owner
3. covenant and epoch
4. policy ID
5. member-set hash
6. certificate status and expiry
7. action-bundle hash
8. operation ID
9. capability armed and not suspended
10. adapter version
11. target program
12. discriminator
13. exact ordered account metas
14. exact instruction data hash
15. effect limit
16. capability nonce
17. operation not previously consumed
18. CPI
19. durable receipt write

---

# 15. Privacy boundary

## 15.1 Protected from unauthorized public observers

- raw incident claim
- private evidence payload
- individual member decision
- individual submission time where avoidable
- exact live approval count
- exact live rejection count
- responder notes
- unexecuted action-bundle details when policy requires concealment

## 15.2 Public

- covenant membership and epoch
- policy commitments
- adapter manifests and bounds
- incident existence after public certificate or action
- scrubbed incident ID
- action-bundle hash
- aggregate terminal counts
- certificate hash
- target protocol state
- adapter receipts
- settlement receipt
- expiry and reconciliation state

## 15.3 Explicit limitations

VINCT does not claim:

- traffic-analysis resistance
- hidden program use
- hidden incident existence
- hidden timing
- gas or compute indistinguishability
- secrecy against a compromised TEE
- proof of workload identity from a fresh TDX quote alone
- protection against an authorized member copying evidence
- indefinite secrecy after voluntary disclosure

The application must separately allowlist expected TEE workload measurements if workload identity is part of a public claim. A helper that verifies a genuine fresh TDX quote is not by itself proof of which code ran.

## 15.4 Client rules

- never persist raw private incident payload in localStorage
- never send raw private content to analytics, error tracking, or logs
- disable session replay on private routes
- redact wallet signatures, JWTs, RPC bodies, and incident values
- clear private form state after acknowledgement
- use a dedicated content-security policy
- require explicit permission before copying evidence
- make production and demo instrumentation visibly distinct

---

# 16. Membership, quarantine, and epochs

When an incident opens, freeze:

- member set
- member roles
- threshold
- policy
- action bundle
- adapter versions
- expiry
- circle epoch

Normal member removal changes future epochs only.

Active-incident quarantine:

- requires a separate high-threshold authority
- stops new attestations from the member
- discards that member's approval
- retains that member's rejection against the rejection ceiling
- does not lower the original threshold
- may make certification impossible
- impossible incidents expire or move to manual response

A suspected compromise must never make automatic execution easier.

> **Refined in Phase 1. See `docs/decision-log.md` D-0013.**
>
> "Invalidates that member's current attestation" was implemented literally and created a
> hole a property test found: quarantining a dissenter erased their rejection, which could
> drop the count back under the ceiling and turn a `RejectedByThreshold` incident into a
> certified one. Preserving `required_approvals` alone is not enough, because the ceiling
> is the second gate.
>
> Quarantine is therefore asymmetric. An approval from a possibly-compromised key is
> discarded; a rejection cast while the member was trusted keeps counting. Both directions
> are fail-safe, and only one of them is available to an attacker who controls the
> quarantine authority. A member's own superseded record never counts either way.

---

# 17. Incident claim model

```rust
pub struct IncidentClaim {
    pub dependency_namespace: DependencyNamespace,
    pub dependency_id: [u8; 32],
    pub observation_window_start: i64,
    pub observation_window_end: i64,
    pub claim_schema_hash: [u8; 32],
    pub private_evidence_digest: [u8; 32],
    pub signal_category: SignalCategory,
    pub confidence_bucket: ConfidenceBucket,
    pub requested_action_category: ActionCategory,
    pub submitter: Pubkey,
    pub submission_nonce: u64,
}
```

The policy defines a compatibility predicate. The core demo accepts claims only when:

- dependency ID matches the covenant
- requested action category matches the policy
- observation window is valid
- member is eligible
- nonce is unused

VINCT does not adjudicate forensic truth. It evaluates whether pre-agreed certification conditions were met.

---

# 18. MagicBlock integration requirements

## 18.1 Current source lock

Initial implementation planning is based on:

- MagicBlock development skill commit `b6edd28e7f6b4433de5e6fbfe316f97efe36181f`
- MagicBlock engine examples commit `a291e4b2c9cc4bab6918ff434d9aaa72c702cf29`
- Rust `ephemeral-rollups-sdk` known-good snapshot `0.16.2`
- current SDK builder `MagicIntentBundleBuilder`
- ER-local PER permission lifecycle
- current Magic Actions delivery and retry semantics

These are source snapshots, not permanent claims of latest versions. Phase 0 must re-fetch and lock the live versions actually compiled.

## 18.2 Required SDK behavior

- use `MagicIntentBundleBuilder`
- do not use deprecated free commit helpers
- use the correct `anchor` or `anchor-compat` SDK feature after the compatibility probe
- use `access-control` for PER
- use SDK constants rather than copied program IDs where available
- put `#[ephemeral]` before `#[program]`
- use `#[delegate]`, `#[commit]`, and `#[action]` on the correct contexts
- create the protected data account on base
- delegate the data account on base
- create, update, and close `EphemeralPermission` on the ER
- do not create or delegate a separate base-layer permission account
- resolve the ER endpoint through router `getDelegationStatus`
- route initialization and delegation to base
- route delegated mutations, commit, and undelegation to the resolved ER
- observe base propagation after commit and undelegation

## 18.3 Magic Actions correctness

Each `CallHandler` must define:

- destination program
- exact ordered short account metas
- exact encoded instruction data
- escrow authority
- measured per-action compute units

The destination program must be present in the outer commit context.

PDA escrow authority requires signed intent construction with the correct seeds.

The application must retain:

- expected action manifest
- ER scheduling signature
- base transaction or commitment signature
- action receipts
- target state observations
- final settlement receipt
- timeout and reconciliation result

Scheduling success is `INTENT_ACCEPTED`, not `SETTLED`.

## 18.4 Commit sponsorship

Each delegated account has a limited default sponsored commit allowance in the current skill snapshot. Phase 0 must verify the live behavior.

The product must:

- count intended commits
- avoid periodic commits while private fields exist
- use terminal scrub-and-commit
- define delegated payer funding
- support `magic_fee_vault` only after validating the current canonical PDA and fee path
- fail visibly when the payer or escrow is underfunded
- never discover sponsorship exhaustion during the demo

## 18.5 Local and live environments

Deterministic logic:

- Rust unit and property tests
- LiteSVM or Mollusk where compatible
- CU benchmarks

Cross-runtime local:

- pinned `@magicblock-labs/ephemeral-validator`
- `mb-stack`
- base RPC, ER RPC, and public query-filtering endpoint
- no claim of hardware TEE attestation

Live integration:

- MagicBlock Devnet base RPC
- Devnet Router
- router-resolved TEE-backed PER endpoint
- target program deployments
- real delegation, permission, action, crank, and settlement observations

Before every live run:

```bash
curl -sS https://status.magicblock.app/api/services | jq .
```

Record network, region, endpoint, service status, timestamp, and the relevant services. Do not continue a demo rehearsal against a known-down dependency without switching to the documented fallback.

---

# 19. Failure and recovery

## 19.1 Failure classes

- base initialization failure
- delegation failure
- router mismatch
- PER authentication failure
- permission lifecycle failure
- protected-state leak
- stale or unauthorized member
- threshold noncompletion
- crank registration delay
- crank execution delay
- certificate expiry
- action construction error
- wrong account meta
- missing signer seed
- insufficient escrow funding
- per-action compute exhaustion
- total transaction size or account limit
- target protocol rejection
- action attempt reverted
- BaseActions removed before commit retry
- commit without actions
- provider or RPC observation gap
- undelegation stall
- duplicate recovery request

## 19.2 Settlement classification algorithm

```text
if final settlement receipt exists
and every adapter receipt exists
and every target protocol effect matches:
    ALL_ACTIONS_APPLIED
else if certificate checkpoint exists
and no adapter receipt exists
and no target effect exists:
    COMMIT_WITHOUT_ACTIONS
else if any required effect exists but the cohort is incomplete:
    PARTIAL_OBSERVATION
else:
    UNKNOWN
```

`PARTIAL_OBSERVATION` triggers a critical alert and blocks automated recovery.

## 19.3 Recovery rules

- no client may execute only the missing base action automatically
- no original nonce may be reused
- every recovery has a new operation ID
- recovery requires current base-state evidence
- recovery expires
- recovery is limited to the original bounded action category
- the original operation remains immutable
- the proof page shows both original and recovery operations
- the claim ledger describes the limitation honestly

## 19.4 Manual recovery owner

For the hackathon reference system, the demo operator and protocol authorities jointly approve recovery.

For a production path, ownership is a covenant policy decision and must not default to the steward.

---

# 20. Security invariants

1. The circle never holds arbitrary protocol admin authority.
2. Every adapter is owned and controlled by its protocol authority.
3. Every executable action is bounded before the incident.
4. Account order is committed exactly.
5. Private fields cannot commit or undelegate.
6. One member contributes at most one current decision.
7. Threshold and member set are frozen per incident.
8. Quarantine never lowers threshold.
9. A certificate is cluster-bound, covenant-bound, epoch-bound, incident-bound, policy-bound, bundle-bound, and nonce-bound.
10. Adapter execution is idempotent per operation ID.
11. Settlement requires observed effects, not scheduling or commit alone.
12. Recovery cannot silently overwrite original evidence.
13. Expiry is monotonic.
14. Crank retries cannot duplicate an economic or protocol effect.
15. Permission visibility does not grant business authorization.
16. Delegation status does not grant business authorization.
17. UI state cannot upgrade an on-chain or ER state.
18. Test fixture state is labelled.
19. Production claims cannot exceed the highest proof rung reached.
20. No private material enters telemetry.

---

# 21. Threat model

| Threat | Consequence | Control | Required test |
|---|---|---|---|
| compromised responder | false attestation | threshold, frozen membership, nonce, quarantine | one compromised member cannot certify alone |
| compromised protocol authority | malicious adapter update | epoch/version ratification, local ownership, expiry | stale adapter version rejected |
| malicious steward | attempts control | steward cannot arm adapters or lower local bounds | steward-only action rejected |
| forged certificate | unauthorized pause | owner, PDA, hashes, nonce, expiry | random account rejected |
| account-meta substitution | different CPI target | ordered meta hash | mutate each meta field |
| replay across incident | repeated pause | incident ID and operation ID | prior certificate rejected |
| replay across cluster | cross-network reuse | genesis hash | devnet vector rejected on localnet |
| threshold leak | coercion or timing leverage | sealed responses, no live k/n | unauthorized/member query denied |
| member withholding | liveness loss | k-of-n without all-member reveal, expiry | offline member does not block valid threshold |
| quarantine manipulation | easier threshold | no threshold reduction | quarantine cannot certify incident |
| private-state commit | permanent leak | zeroization gate | commit instruction rejects unsanitized state |
| TEE metadata leak | attacker learns activity | honest limitation, short windows | no content appears, existence may remain visible |
| wrong TEE workload | false trust | expected measurement allowlist | mismatched measurement rejected where implemented |
| action failure | no protocol effect | settlement watcher and recovery state | deliberately failing adapter |
| action stripping on retry | certificate but no actions | `COMMIT_WITHOUT_ACTIONS` | observe target environment behavior |
| compute exhaustion | settlement failure | per-action CU benchmark, limits | maximum fixture |
| escrow exhaustion | action failure | funding preflight and alert | zero escrow case |
| naive retry | double effect | durable operation ID | duplicate recovery rejected |
| router mismatch | invalid state/runtime | `getDelegationStatus` | wrong regional endpoint fails safely |
| crank duplicate | repeated expiry | idempotent terminal handler | repeated iteration |
| XSS/session theft | private access | CSP, short auth, no storage | browser security test |
| malicious verifier UI | false green state | standalone CLI verifier | compare UI and CLI output |

---

# 22. Executable reference model

Create a pure Rust crate with no Anchor or network dependency.

It is the specification for:

- covenant epoching
- policy evaluation
- sealed attestation replacement
- quarantine
- incident expiry
- action-bundle hashing
- certificate construction
- settlement classification
- recovery operation creation

Required properties:

- deterministic output
- no hidden clock source
- explicit slot/time input
- no floating point
- stable Borsh vectors
- generated TypeScript fixtures
- exhaustive tests for a three-member circle
- property tests for larger member sets

Core function:

```rust
pub fn evaluate_incident(
    covenant: &CovenantSnapshot,
    incident: &IncidentSnapshot,
    attestations: &[Attestation],
    now_slot: u64,
) -> EvaluationResult
```

Required cases:

- zero members
- invalid threshold
- duplicate members
- duplicate attestation nonce
- replacement before certification
- stale epoch
- wrong action bundle
- member removed in future epoch
- quarantined active member
- approvals meet threshold
- maximum rejections exceeded
- expiry before threshold
- threshold reached exactly at boundary
- certificate expiry
- replayed operation ID
- every action-hash mutation
- no actions observed
- all actions observed
- conflicting partial observation
- unknown RPC observation

Production integration tests must compare results with this crate. Do not independently reimplement expected values.

---

# 23. APIs and instructions

## 23.1 Core base instructions

- `initialize_covenant`
- `add_member_draft`
- `add_policy_draft`
- `ratify_covenant`
- `activate_epoch`
- `suspend_covenant`
- `initialize_incident_account`
- `delegate_incident_account`
- `initialize_recovery_operation`
- `finalize_reconciliation`

## 23.2 Core ER/PER instructions

- `create_incident_permission`
- `update_incident_permission`
- `open_incident`
- `submit_sealed_attestation`
- `quarantine_member`
- `expire_incident`
- `scrub_and_schedule_settlement`
- `close_incident_permission`
- `commit_and_undelegate_incident`

## 23.3 Adapter instructions

- `install_capability`
- `arm_capability`
- `suspend_capability`
- `renew_capability`
- `revoke_capability`
- `execute_bounded_action`
- `execute_recovery_action`

`execute_bounded_action` is the Magic Action target and uses the current SDK `#[action]` surface.

## 23.4 Mock protocol instructions

- `initialize_market`
- `set_adapter`
- `pause_new_borrowing`
- `reset_demo_market`

`reset_demo_market` must require explicit demo authority and must not exist in a production feature set.

---

# 24. UI requirements

## 24.1 Routes

- `/`
- `/circles`
- `/circles/new`
- `/circles/[covenant]`
- `/circles/[covenant]/formation`
- `/circles/[covenant]/adapters`
- `/circles/[covenant]/incidents/new`
- `/incidents/[incident]`
- `/incidents/[incident]/private`
- `/incidents/[incident]/settlement`
- `/proof/[operationId]`
- `/demo`
- `/settings/network`

## 24.2 Formation screen

Must show:

- three independent protocol identities
- covered dependency
- exact action category
- threshold
- expiry
- adapter ownership
- adapter bounds
- ratification status
- base explorer link

Must state:

```text
Each protocol keeps control of its own adapter.
VINCT receives no unrestricted admin key.
```

## 24.3 Private incident room

Authorized member view:

- private claim
- submit decision
- uniform accepted response
- deadline
- no other member's decision
- no exact live count

Observer view:

- incident active
- deadline
- covenant and action category
- no protected content
- no exact live count

## 24.4 Settlement screen

Statuses:

- certifying
- intent accepted
- settling
- all actions observed
- commit without actions
- reconciliation required
- settlement unknown
- settled

Never collapse these into one spinner.

## 24.5 Proof page

Read-only, no wallet required.

Show:

- product sentence
- covenant
- circle epoch
- member-set hash
- policy
- operation ID
- action-bundle hash
- ER signature
- base transaction
- expected actions
- observed adapter receipts
- observed protocol states
- final settlement receipt
- settlement classification
- replay test
- privacy statement
- limitations
- verifier command
- source links

---

# 25. Observability

Structured public logs may include:

- operation ID
- incident ID
- state transition
- expected action index
- adapter key
- base transaction signature
- settlement classification
- timeout
- error code

Logs must never include:

- raw claim
- raw evidence
- decision
- member-specific private submission
- JWT
- wallet signature
- private RPC body
- TEE challenge secret

Required correlation IDs:

- `covenant_id`
- `circle_epoch`
- `incident_id`
- `operation_id`
- `action_index`
- `recovery_operation_id`
- ER signature
- base signature

---

# 26. Performance and resource budgets

The seam spike must measure, not estimate:

- CU per adapter action
- CU for final receipt action
- total attempted base transaction CU
- serialized transaction size
- account count
- action scheduling ER CU
- time from intent acceptance to base observation
- time from threshold to terminal classification

Guardrails:

- target total under 1.2M CU to preserve margin below Solana's transaction maximum
- no individual action uses an unmeasured default
- no hidden account added by the SDK is omitted from the budget
- use address lookup tables only after a plain versioned transaction is measured
- record p50, p95, and maximum over repeated local and Devnet runs
- fail CI if the reference bundle exceeds the accepted regression threshold

The exact accepted threshold is locked after the first real seam measurement.

---

# 27. Testing strategy

## 27.1 Pure logic

- Rust unit tests
- property tests
- hash vectors
- exhaustive three-member state space
- zeroization tests
- settlement-classification tests

## 27.2 Program tests

Use LiteSVM or Mollusk where compatible for:

- account constraints
- PDA derivation
- signer and owner validation
- adapter bounds
- replay protection
- protocol-only adapter authority
- compute measurement

Do not claim these prove ER routing, PER, cranks, or Magic Actions delivery.

## 27.3 Local MagicBlock stack

Use a pinned local stack for:

- base initialization
- delegation
- router or explicit local routing where supported
- ER writes
- commit
- undelegation
- action scheduling
- failure path
- cross-runtime logs

Local query filtering does not prove hardware TEE attestation.

## 27.4 Devnet

Required:

- live router discovery
- delegated-account ownership assertions
- PER access-control lifecycle
- authorized read and write
- unauthorized read rejection
- scrub-before-commit
- Magic Action successful cohort
- deliberate failing action
- actual retry/removal behavior
- crank request, registration, iteration, and expiry
- base propagation
- read-only verifier

## 27.5 Browser tests

Playwright:

- formation
- wallet state boundaries
- private route access
- unauthorized observer
- no localStorage private payload
- settlement states
- proof page
- resettable demo
- direct refresh and deep links
- unavailable RPC state

## 27.6 Security tests

- account substitution
- stale adapter
- wrong cluster
- stale epoch
- forged certificate
- duplicate attestation
- quarantine
- replay
- zeroization
- telemetry leak scan
- dependency audit
- secret scan
- supply-chain lockfile verification

---

# 28. Proof ladder

| Rung | Evidence |
|---|---|
| 1 | pure Rust reference model and canonical vectors |
| 2 | unit, property, adversarial, and zeroization tests |
| 3 | sovereign adapter and mock protocol program tests |
| 4 | measured three-adapter Magic Action seam in local supported environment |
| 5 | local cross-runtime incident lifecycle |
| 6 | TEE-backed PER access-control lifecycle on Devnet |
| 7 | target-network successful action cohort |
| 8 | target-network action failure and exact retry/removal classification |
| 9 | browser interaction |
| 10 | standalone read-only verifier and proof page |

No public claim may exceed its rung.

---

# 29. Repository structure

```text
vinct/
├── CLAUDE.md
├── README.md
├── Anchor.toml
├── Cargo.toml
├── package.json
├── pnpm-lock.yaml
├── rust-toolchain.toml
├── programs/
│   ├── vinct-core/
│   ├── vinct-adapter/
│   └── vinct-mock-protocol/
├── crates/
│   ├── vinct-reference/
│   ├── vinct-types/
│   └── vinct-verifier-core/
├── packages/
│   ├── client/
│   ├── verifier/
│   ├── test-vectors/
│   └── config/
├── apps/
│   └── web/
├── tests/
│   ├── program/
│   ├── local-stack/
│   ├── devnet/
│   ├── adversarial/
│   └── e2e/
├── scripts/
│   ├── source-lock.ts
│   ├── check-magicblock-status.ts
│   ├── bootstrap-local.sh
│   ├── deploy-devnet.sh
│   ├── run-demo.ts
│   ├── reconcile.ts
│   └── verify-proof.ts
├── docs/
│   ├── PRD.md
│   ├── architecture.md
│   ├── architecture-manifest.yaml
│   ├── source-lock.md
│   ├── decision-log.md
│   ├── threat-model.md
│   ├── privacy-boundary.md
│   ├── claim-ledger.json
│   ├── proof-ladder.md
│   ├── demo-script.md
│   └── runbooks/
│       ├── delegation.md
│       ├── settlement.md
│       ├── reconciliation.md
│       └── service-outage.md
└── artifacts/
    ├── benchmarks/
    ├── test-vectors/
    ├── devnet/
    └── proof/
```

---

# 30. Source and dependency policy

Do not begin by installing remembered versions.

Phase 0 procedure:

1. Install the MagicBlock development skill.
2. Install the current Solana development skill.
3. Record both skill commit SHAs.
4. Record current MagicBlock engine examples commit.
5. Inspect:
   - `magic-actions/anchor`
   - `private-counter/anchor`
   - `crank-counter/anchor`
6. Record all relevant Cargo, npm, toolchain, and lockfile versions.
7. Create the smallest compatibility probe using:
   - Anchor line candidate
   - `ephemeral-rollups-sdk`
   - `access-control`
   - Magic Actions
   - crank API
8. Compile and run `cargo check`.
9. Start the pinned local stack.
10. Query the live status API.
11. Write exact versions and source SHAs to `docs/source-lock.md`.
12. Commit lockfiles before feature work.

Initial candidate, subject to the probe:

```toml
ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor", "access-control"] }
```

The current MagicBlock skill supports Anchor 1.x through `anchor` and Anchor 0.28 to below 1.0 through `anchor-compat`. Preserve the version line of the selected working example unless the compatibility probe proves a better combination.

For TypeScript, choose one Solana client stack and isolate any legacy interop behind `packages/client`. Do not mix `@solana/kit` and `@solana/web3.js` types throughout the application.

---

# 31. CI gates

Required jobs:

- formatting
- Rust lint
- TypeScript lint
- typecheck
- reference-model tests
- program tests
- property tests
- canonical vector parity
- CU benchmark regression
- local-stack lifecycle
- Playwright smoke
- secret scan
- dependency audit
- generated claim-ledger validation

Devnet jobs may be manual or scheduled because they require funding and live services. Their artifacts must be retained.

A phase cannot pass because CI is green if its target-chain evidence is still absent.

---

# 32. Claim ledger

Every public claim records:

```json
{
  "id": "claim-id",
  "wording": "Exact public wording",
  "status": "verified",
  "proof_level": 8,
  "network": "devnet",
  "source_commit": "sha",
  "program_ids": [],
  "transactions": [],
  "commands": [],
  "artifacts": [],
  "verified_at": "ISO-8601",
  "limitations": []
}
```

Allowed statuses:

- `verified`
- `failed`
- `unavailable`
- `reported_not_independently_verified`

Do not count:

- deployed but unused programs
- ER scheduling signatures as completed actions
- later commit as proof of removed actions
- mocked external calls as live integrations
- estimated CU as measured CU
- test wallets as users
- hidden fixtures as organic activity

---

# 33. Two-minute judge path

1. Open `/proof/[operationId]`.
2. Inspect the ratified covenant and protocol-owned adapter bounds.
3. Inspect the successful incident certificate and expected action bundle.
4. Open the base transaction and adapter receipts.
5. Run or view the verifier result.
6. Inspect the deliberate failing operation and its honest delivery classification.
7. Watch the short demo.

No wallet is required for read-only inspection.

---

# 34. Three-minute demo

## 0:00 to 0:25

Three protocol teams join one formation room.

They agree on:

```text
dependency: shared oracle fixture
action: pause new borrowing
threshold: 2 of 3
certificate lifetime: short bounded window
```

Each protocol ratifies.

Caption:

```text
Mutual-aid covenant ratified
3 sovereign adapters
0 external admin keys
```

## 0:25 to 0:45

Open one adapter manifest.

Show:

- protocol-owned authority
- exact pause instruction
- exact accounts
- expiry
- effect bound
- no arbitrary CPI

## 0:45 to 1:15

Open a private incident.

Protocol A submits a sealed decision.

Protocol B submits a sealed decision.

Observer screen shows only:

```text
Incident active
Awaiting covenant outcome
```

## 1:15 to 1:45

The threshold is reached.

Show:

```text
Certificate issued
Intent accepted
Settling
```

Then show the base transaction and all three protocol states.

Only after receipts and states are observed:

```text
SETTLED
3 of 3 required effects verified
```

## 1:45 to 2:10

Run the standalone verifier.

Show:

- covenant hash
- action-bundle hash
- certificate
- adapter receipts
- target states
- final settlement receipt

## 2:10 to 2:40

Run the failure case with one malformed adapter account.

Show the attempted failure.

Then show the actual target-environment result:

- reverted attempt
- whether the committor removed actions and committed the scrubbed checkpoint
- VINCT classification

Required caption:

```text
VINCT does not confuse a committed certificate with executed actions.
```

## 2:40 to 3:00

Final frame:

```text
VINCT

Binding mutual aid for protocols.

They agree before the crisis.
They attest without exposing the incident.
Their own adapters act from one certified outcome.
```

---

# 35. Kill criteria

Stop or redesign if:

- the current Magic Actions stack cannot express the required action cohort
- the target environment cannot keep the required actions in one intended transaction strategy
- the total bundle exceeds practical compute, account, or transaction-size limits
- PER exposes protected content to unauthorized clients
- private fields cannot be reliably zeroized before commit
- a protocol-owned adapter requires general admin authority
- a certificate cannot be verified independently
- action stripping cannot be detected
- reconciliation cannot distinguish committed checkpoint from delivered actions
- one real security operator rejects even unarmed locally owned adapters for drills
- the only working proof is decorative toy state with no credible protocol analogue
- the explanation requires hiding Magic Actions recovery behavior

---

# 36. Expansion admission

Allowed only after the core proof passes:

- Squads-controlled adapter
- real protocol adapter with permission
- response-readiness drills
- dependency registry
- selective post-incident disclosure
- external security responder role
- insurance or audit attestation integrations after validation
- internal-circuit templates
- additional low-blast-radius action categories

Deferred:

- cross-chain
- automatic detection
- agent responders
- token incentives
- governance marketplace
- broad adapter SDK
- high-value treasury movement

---

# 37. Definition of done

The core is done only when:

- the reference model predicts the result
- the production program matches the model
- the private boundary is tested in a TEE-backed PER environment
- private fields are scrubbed before public settlement
- three protocol-owned adapters are real program authorities for the mock protocols
- a successful action cohort is observed on the target network
- a deliberate action failure is observed and classified according to actual committor behavior
- no missing action is presented as executed
- replay fails
- expiry works
- CU and transaction limits are measured
- the browser reaches the result
- a read-only verifier reproduces the claim
- the claim ledger contains no inflated wording
- the proof path takes under two minutes
- the headline result fits one screenshot

# 38. Engineering operations and deployment policy

## 38.1 Local-first development

VINCT uses a local-first engineering loop.

Before relying on any remote workflow:

- build locally
- lint locally
- typecheck locally
- run the full deterministic test suite locally
- run program tests locally
- run configuration validation locally
- run deployment dry-runs where the platform supports them
- run the same command set intended for CI

GitHub Actions exists to confirm reproducibility and protect the final submission. It is not the primary development debugger.

Avoid creating many PRs during the hackathon build. Direct commits on the authenticated working branch are acceptable unless repository policy requires otherwise.

## 38.2 Commit identity

All commits:

- use the Git identity already authenticated in the environment
- contain no `Co-Authored-By` trailer
- contain no AI attribution trailer
- contain no generated-by footer
- use concise messages describing the actual change

## 38.3 Repository publication

The repository may remain local through the early implementation gates.

Create the GitHub repository after the core local gates are healthy and remote evidence, deployment, collaboration, or submission requires it.

Before first push:

1. run the complete local pre-push gate
2. inspect tracked files
3. scan for secrets
4. verify lockfiles
5. verify generated artifacts intended for source control
6. verify README accuracy
7. verify claim-ledger wording
8. confirm no private fixtures are committed

After creation, configure:

- repository name: `vinct` unless unavailable
- description based on the locked product sentence
- relevant topics such as `solana`, `magicblock`, `ephemeral-rollups`, `privacy`, `security`, `incident-response`
- homepage or live demo URL once deployed
- README
- LICENSE when appropriate
- SECURITY.md when appropriate

Keep remote CI small. Do not require PR churn or slow branch rules unless they add real value.

## 38.4 Database

No database is required for VINCT's core protocol.

If an off-chain relational store becomes justified, use Supabase Postgres. Appropriate uses include:

- public indexing
- reconciliation cache
- public operation search
- demo metadata
- operational dashboards

Supabase must not become protocol truth.

Rules:

- every chain-derived record should be rebuildable where practical
- migrations live in the repository
- migrations are tested before deployment
- service-role keys remain server-side
- Workers or browser clients receive only the minimum required credentials
- do not add a Cloudflare database product when Supabase already satisfies the requirement
- do not add Supabase at all unless an off-chain database solves a real need

## 38.5 Cloudflare

Use the existing Cloudflare Workers account when Workers are useful for deployment.

Good uses:

- web/API edge surface
- read-only proof API
- reconciliation polling
- scheduled public-state refresh
- lightweight submission/demo infrastructure

Forbidden uses:

- holding protocol administrator keys
- acting as the only settlement authority
- silently deciding incident outcomes
- storing private incident truth as the canonical record

All Worker configuration must be validated locally before deployment.

## 38.6 Writing and voice guidance

Before generating public-facing copy, implementation agents must inspect the Claude project root for the user's writing and voice Markdown files.

If present, they govern:

- README prose
- repository description
- docs narrative
- landing page
- submission copy
- demo script
- launch copy
- social copy

They do not override technical correctness, security warnings, or evidence requirements.

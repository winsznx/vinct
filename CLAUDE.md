# CLAUDE.md

You are implementing VINCT.

Read these files before changing code:

1. `docs/PRD.md`
2. `docs/architecture-manifest.yaml`
3. `docs/source-lock.md`
4. `docs/claim-ledger.json`
5. `docs/decision-log.md`
6. the active phase in `docs/IMPLEMENTATION_GATES.md`

Use the installed MagicBlock and Solana development skills. Re-read the relevant skill references before touching delegation, PER permissions, Magic Actions, cranks, routing, signing, or settlement.

## Product sentence

VINCT lets protocols sharing a critical dependency ratify a private mutual-aid covenant, certify an incident inside PER, and coordinate their own bounded adapters through MagicBlock.

## Non-negotiable product rules

- The circle never receives arbitrary protocol admin authority.
- Each protocol owns its own bounded adapter.
- No arbitrary CPI.
- No private incident field may commit or undelegate.
- Preserve exact Solana account order in canonical action hashes.
- No exact live quorum progress is public.
- Freeze membership, policy, threshold, and adapter versions per incident.
- Quarantine never lowers threshold.
- Use `MagicIntentBundleBuilder`.
- An ER scheduling signature means intent accepted, not settled.
- A successful later commit does not prove the originally scheduled BaseActions ran.
- Observe and reconcile every expected base-layer effect.
- `COMMIT_WITHOUT_ACTIONS` is a required state.
- Never blindly retry one missing action.
- Every recovery uses a new operation ID and nonce.
- Do not mark `SETTLED` until all adapter receipts, target effects, and the final settlement receipt are observed.
- No dashboard work before the dominant seam passes.
- No feature broadening without an admitted extension.

## Working method

For each phase:

1. Inspect the repository and current evidence.
2. State the smallest coherent plan.
3. Identify assumptions that could invalidate the phase.
4. Implement only the phase scope.
5. Run every required command.
6. Save signatures, logs, test vectors, and benchmarks under `artifacts/`.
7. Update `docs/claim-ledger.json`.
8. Update `docs/decision-log.md`.
9. Return PASS or FAIL against the exact phase gate.
10. Keep work local unless the active phase explicitly requires remote evidence or the final repository publish step.
11. Stop at the phase boundary.

Do not report success from source inspection alone.

## Source policy

Before adding or changing a dependency:

- inspect the target example manifest and lockfile
- inspect current upstream official source
- record the version and source SHA in `docs/source-lock.md`
- run the compatibility probe
- commit the lockfile

Never invent program IDs, RPC endpoints, package versions, seeds, account order, or service behavior.

## MagicBlock routing

- initialize and delegate on base
- discover ER placement through router `getDelegationStatus`
- use the returned FQDN for delegated mutations
- commit and undelegate through the ER
- observe base propagation
- never hardcode a regional ER endpoint
- never reuse a base blockhash for an ER transaction

## Privacy

Never log, persist, export, or send to telemetry:

- raw incident claims
- evidence
- decisions
- member-specific private submission data
- JWTs
- signatures
- private RPC request bodies

Any instruction capable of commit or undelegation must reject when `private_fields_zeroized` is false.

## Testing

A passing lower-fidelity test cannot substitute for a higher proof rung.

- pure model for economics and state transitions
- program tests for account and authority constraints
- CU benchmarks for action limits
- local MagicBlock stack for routing and cross-runtime lifecycle
- TEE-backed Devnet PER for confidentiality
- Devnet for Magic Actions, crank, and settlement
- browser and standalone verifier for user and judge paths

## Failure handling

When a Magic Action fails:

- record the attempted base transaction
- inspect whether all BaseActions in the strategy were removed
- inspect whether the scrubbed commit later landed
- classify the operation
- do not independently replay the base action
- create a governed recovery proposal only after reconciliation

## Code quality

- Rust denies warnings in CI where practical
- explicit errors, no generic `InvalidArgument`
- checked arithmetic
- bounded vectors and account sizes
- versioned Borsh structs
- deterministic hashes
- no unsafe code without written approval
- no `unwrap` or `expect` in program paths
- no fixed sleeps when polling is possible
- no secret values in fixtures
- idempotent scripts
- reproducible commands
- exact files changed in every report

## Local-first engineering and deployment policy

Treat local correctness as the default development loop.

### Local-first workflow

- Build, lint, typecheck, test, benchmark, and dry-run configuration locally before relying on remote CI.
- Do not create a pull request for every phase or small change.
- Do not wait on GitHub Actions to discover issues that can be reproduced locally.
- Keep one coherent local branch unless a separate branch is genuinely useful for risky experimentation.
- Run the repository's intended CI commands locally before any push.
- Keep GitHub Actions small and final-gate oriented. Remote CI confirms reproducibility, it is not the primary debugger.
- If a workflow fails remotely, reproduce the exact command locally before changing code.
- Do not add CI jobs merely for ceremony.

### Git and GitHub

- Use the GitHub account already authenticated in the environment.
- Commits must use the authenticated user's normal Git identity.
- Never add `Co-Authored-By`, AI attribution, generated-by trailers, or similar commit-message trailers.
- Use concise conventional commit messages when useful.
- Commit directly to the working branch during implementation.
- Avoid PR churn. Open a PR only when it provides real review value or when repository policy requires one.
- Do not create the public GitHub repository at the beginning merely to have somewhere to push incomplete work.
- Finish the local implementation gates first, then create the repository when the project is ready for remote evidence, deployment, or submission.
- Before the first push, run the full local pre-push gate and inspect `git diff`, `git status`, secrets, generated files, and lockfiles.
- After repository creation, set:
  - repository name
  - concise description
  - relevant topics
  - homepage/demo URL when available
  - README
  - LICENSE if the project is intended to be open source
  - SECURITY.md when security reporting instructions are useful
  - the project documentation required by the submission
- Do not enable branch protection, required PR reviews, or slow workflow gates unless they solve a real collaboration or release problem for this build.

### Database policy

The VINCT core protocol must not depend on an off-chain database.

If an off-chain relational database becomes justified for public metadata, reconciliation indexing, operational state, or deployment support:

- use Supabase Postgres
- prefer the user's free Supabase project instead of adding a separate paid Cloudflare database product
- keep protocol truth on Solana and MagicBlock, never in Supabase
- treat Supabase as a cache, index, or operational store
- make writes idempotent
- make all chain-derived rows rebuildable from chain evidence where practical
- use migrations checked into the repository
- use local or branch-safe migration dry runs before production
- never put service-role secrets in the browser
- do not add Supabase just because it is available

### Cloudflare policy

If a deployable web/API/worker surface is needed and Cloudflare is suitable:

- prefer the user's existing paid Cloudflare Workers account
- keep the deployment stateless where possible
- use Workers for API, reconciliation polling, or lightweight orchestration only where it improves the product
- do not move protocol authority into a Worker
- do not make a Worker the only source of settlement truth
- all Worker configuration must have a local dry-run or validation path before deployment

### Writing and voice files

Before writing any public-facing prose, inspect the Claude project root for writing and voice guidance files.

Look for files such as:

- `writing.md`
- `WRITING.md`
- `voice.md`
- `VOICE.md`
- similarly named writing or voice Markdown files

If present:

- read them before writing README copy, landing-page copy, submission text, docs narrative, repository description, demo narration, social copy, or marketing text
- follow them unless they conflict with factual correctness or this PRD
- do not rewrite those source files unless explicitly asked
- if no such files exist, proceed without inventing them

Technical code comments, test names, and protocol errors should remain precise and should not be distorted to match marketing voice.

## Stop conditions

Stop the phase when:

- source behavior differs from the PRD
- a required live service is down
- a dependency combination does not compile
- private data might commit
- the action cohort cannot fit
- observed Magic Actions behavior differs from the settlement model
- evidence is insufficient to claim the gate passed

Record the evidence and propose the smallest correction.

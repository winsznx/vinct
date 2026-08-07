# Claude Code bootstrap prompt

We are building VINCT.

Read, in order:

1. `CLAUDE.md`
2. `docs/PRD.md`
3. `docs/IMPLEMENTATION_GATES.md`
4. `docs/source-lock.md`
5. `docs/architecture-manifest.yaml`
6. `docs/claim-ledger.json`
7. `docs/decision-log.md`

Then inspect the Claude project root for any writing or voice Markdown files, including names like `writing.md`, `WRITING.md`, `voice.md`, `VOICE.md`, or close variants. Read them if present. They govern public-facing writing, not protocol correctness.

Use the installed MagicBlock and Solana development skills. Read the current MagicBlock architecture-planning, security, Magic Actions, PER access-control, local-development, resources, and crank references before writing implementation code.

Execute Phase 0 only.

Operating rules for this project:

- Work local-first.
- Do not create a GitHub repository yet unless Phase 0 genuinely requires remote evidence that cannot be obtained otherwise.
- Do not open PRs.
- Do not depend on GitHub Actions for the development loop.
- Build, lint, typecheck, test, and dry-run configs locally.
- Any later CI must first be reproducible locally.
- Use the Git identity already authenticated in the environment.
- Never add `Co-Authored-By`, AI attribution, or generated-by trailers to commits.
- Commit locally when a coherent Phase 0 checkpoint passes.
- The core protocol must not depend on an off-chain database.
- If a Postgres database becomes justified later, use Supabase Postgres. Do not add a separate Cloudflare database product.
- If deployment later needs an API or worker, prefer the existing Cloudflare Workers account and keep Workers outside protocol authority.
- Do not add Supabase or Workers in Phase 0 unless the compatibility/source-lock work genuinely requires them.

Phase 0 objectives:

1. Inspect the current official MagicBlock sources and examples.
2. Install or confirm the MagicBlock and Solana development skills and record their source commits.
3. Verify the project files and paths match `CLAUDE.md`.
4. Create the monorepo structure locally.
5. Choose a compatible toolchain through a compile probe, not memory.
6. Pin exact dependencies and lockfiles.
7. Create version and live-service capture scripts.
8. Start and stop the pinned local MagicBlock stack cleanly.
9. Query the current MagicBlock service-status source and retain a timestamped artifact.
10. Produce or update `docs/source-lock.md` and `artifacts/source-lock/version-report.json`.
11. Run all Phase 0 validation locally.
12. Make a local checkpoint commit only after the gate passes.

Do not implement:

- product logic
- UI
- full contracts beyond the smallest compatibility probe
- Supabase
- Cloudflare deployment
- GitHub Actions beyond inspecting whether a future minimal workflow will be needed
- optional features

Critical Magic Actions rule:

Magic Action scheduling is not action completion. Within one attempted base transaction, commit and actions may be atomic, but a failed BaseAction can cause the committor to remove BaseActions in that transaction strategy and retry remaining commit work. VINCT must later observe and reconcile every originally expected action. Do not encode a false settlement model.

Before ending the phase, perform a self-review:

- compare actual outputs with the Phase 0 gate
- verify exact versions and source SHAs
- verify every command reported was actually run
- verify local stack processes were cleaned up
- verify no secrets were added
- verify no stale or guessed package version is described as current

Return:

- exact files created or changed
- exact versions and source SHAs
- commands run
- local test results
- artifacts produced
- local commit SHA if a commit was made
- blockers or unresolved assumptions
- one verdict: `PHASE 0 PASS` or `PHASE 0 FAIL`

Stop after Phase 0. Do not continue into Phase 1.

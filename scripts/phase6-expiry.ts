/**
 * The expiry crank, end to end on the local MagicBlock stack.
 *
 * An incident opens with a short response window and nobody answers it. A task is requested,
 * the scheduler runs it, and the incident reaches a terminal state without anyone acting. Then
 * the private accounts are scrubbed and the family leaves the rollup.
 *
 * The point of the run is the gap between a request and a result. A schedule transaction
 * succeeding means `REQUESTED`. The validator's own log says so: `Scheduled task request with
 * ID`. Everything after that is read from the rollup, and the states are exactly the PRD's:
 *
 *   REQUESTED -> REGISTRATION_OBSERVED -> ITERATION_OBSERVED -> DESIRED_STATE_REACHED
 *             -> CANCELLATION_REQUESTED -> REMOVAL_OBSERVED
 *
 *   bash scripts/bootstrap-local.sh start
 *   pnpm exec tsx scripts/phase6-expiry.ts
 *   pnpm exec tsx scripts/phase6-expiry.ts --cancel   # cancel before the deadline instead
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  CrankState,
  countIterations,
  iterationOutcomes,
  safeToUndelegate,
  watchCancellation,
  watchExpiryCrank,
} from "../packages/monitor/src/index.js";
import {
  CORE_PROGRAM_ID,
  IncidentStatus,
  MemberRole,
  addCovenantMember,
  armCovenant,
  armCovenantMember,
  attestationAddress,
  cancelExpiryCrank,
  canonicalMemberOrder,
  claimAddress,
  closeAttestationPermission,
  closeClaimPermission,
  covenantAddress,
  createAttestationPermission,
  createClaimPermission,
  createCovenant,
  decodeIncidentClaim,
  decodeIncidentCore,
  decodeMemberAttestation,
  delegateAttestation,
  delegateClaim,
  delegateIncident,
  expiryTaskId,
  incidentAddress,
  initializeAttestation,
  initializeClaim,
  initializeIncident,
  interactionOnly,
  openIncident,
  ratifyCovenant,
  ratifyCovenantMember,
  releaseIncident,
  requestExpiryCrank,
  scrubAttestation,
  scrubClaim,
  submitPrivateClaim,
} from "../packages/client/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "local-stack");

const BASE_RPC = process.env.VINCT_BASE_RPC ?? "http://127.0.0.1:8899";
const ER_RPC = process.env.VINCT_ER_RPC ?? "http://127.0.0.1:7799";

/** Cancels the task before the deadline instead of letting it settle the incident. */
const CANCEL_RUN = process.argv.includes("--cancel");
const RUN_LABEL = CANCEL_RUN ? "cancel" : "expire";

/**
 * Short enough that the deadline arrives inside the run, long enough that the first iterations
 * land while the window is still open. Those early iterations are the point: they are what a
 * healthy task does most of the time, and they must do nothing.
 */
const RESPONSE_WINDOW_SLOTS = 120n;
const CRANK_INTERVAL_MS = 1_000n;
const CRANK_ITERATIONS = 32n;
const WATCH_WINDOW_MS = 120_000;
const QUIET_WINDOW_MS = 8_000;
/** Long enough for a few more iterations to fire after the accounts have gone. */
const POST_RELEASE_WATCH_MS = 8_000;

const NAMES = ["alpha", "beta", "gamma"] as const;

const log: string[] = [];
function say(line: string): void {
  log.push(line);
  console.log(line);
}

function sha256(input: string | Buffer): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

function derived(seed: string): Keypair {
  return Keypair.fromSeed(sha256(seed).slice(0, 32));
}

interface Step {
  step: string;
  runtime: "base" | "er" | "none";
  signature?: string;
}
const steps: Step[] = [];

async function send(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  label: string,
  runtime: "base" | "er",
): Promise<string> {
  const transaction = new Transaction().add(...instructions);
  const first = signers[0];
  if (!first) throw new Error("a transaction needs at least one signer");
  transaction.feePayer = first.publicKey;
  const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
    skipPreflight: runtime === "er",
    commitment: "confirmed",
  });
  steps.push({ step: label, runtime, signature });
  say(`  ${label} ${signature.slice(0, 12)}…`);
  return signature;
}

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString();
  const base = new Connection(BASE_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");

  const payer = Keypair.generate();
  await base.confirmTransaction(
    await base.requestAirdrop(payer.publicKey, 50_000_000_000),
    "confirmed",
  );

  const validator = new PublicKey(
    (
      (await (
        await fetch(ER_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
        })
      ).json()) as { result: { identity: string } }
    ).result.identity,
  );
  const clusterGenesisHash = new PublicKey(await base.getGenesisHash()).toBytes();

  const steward = derived(`phase6:${RUN_LABEL}:steward`);
  const protocols = NAMES.map((name) => ({
    name,
    authority: derived(`phase6:${RUN_LABEL}:protocol:${name}`),
  }));
  const memberKeys = protocols.map((p) => p.authority.publicKey);
  for (const keypair of [steward, ...protocols.map((p) => p.authority)]) {
    await base.confirmTransaction(
      await base.requestAirdrop(keypair.publicKey, 10_000_000_000),
      "confirmed",
    );
  }

  let covenantId = 1n;
  while (await base.getAccountInfo(covenantAddress(steward.publicKey, covenantId))) {
    covenantId += 1n;
    if (covenantId > 64n) throw new Error("no free covenant id; restart the local validator");
  }
  const covenant = covenantAddress(steward.publicKey, covenantId);
  const incidentId = 1n;
  const core = incidentAddress(covenant, incidentId);
  const claim = claimAddress(core);
  const opener = protocols[0]!.authority;

  say(`VINCT Phase 6 — expiry crank on the local stack (${RUN_LABEL})`);
  say(`  base ${BASE_RPC}   er ${ER_RPC}`);
  say(`  incident ${core.toBase58()}`);
  say(`  response window ${RESPONSE_WINDOW_SLOTS} slots`);
  say("");

  say("Forming the covenant");
  await send(
    base,
    [
      createCovenant(steward.publicKey, {
        covenantId,
        circleEpoch: 1n,
        clusterGenesisHash,
        policyId: sha256(`phase6:${RUN_LABEL}:policy`),
        actionBundleTemplateHash: sha256(`phase6:${RUN_LABEL}:template`),
        requiredApprovals: 2,
        maximumRejections: 1,
        responseWindowSlots: RESPONSE_WINDOW_SLOTS,
        certificateLifetimeSlots: 500_000n,
        epochLifetimeSlots: 10_000_000n,
      }),
    ],
    [steward],
    "convene",
    "base",
  );
  for (const member of canonicalMemberOrder(memberKeys)) {
    await send(
      base,
      [
        addCovenantMember(
          covenant,
          steward.publicKey,
          member,
          MemberRole.Protocol,
          PublicKey.default,
        ),
      ],
      [steward],
      `add ${member.toBase58().slice(0, 8)}`,
      "base",
    );
  }
  for (const protocol of protocols) {
    await send(
      base,
      [ratifyCovenantMember(covenant, protocol.authority.publicKey)],
      [protocol.authority],
      `${protocol.name} ratifies`,
      "base",
    );
  }
  await send(base, [ratifyCovenant(covenant, memberKeys)], [payer], "covenant ratifies", "base");
  for (const protocol of protocols) {
    await send(
      base,
      [armCovenantMember(covenant, protocol.authority.publicKey, 1)],
      [protocol.authority],
      `${protocol.name} arms`,
      "base",
    );
  }
  await send(base, [armCovenant(covenant)], [payer], "covenant arms", "base");

  say("\nOpening the incident");
  await send(
    base,
    [initializeIncident(opener.publicKey, covenant, incidentId)],
    [opener],
    "incident core",
    "base",
  );
  await send(base, [initializeClaim(core, opener.publicKey)], [opener], "claim", "base");
  for (const [index, protocol] of protocols.entries()) {
    await send(
      base,
      [initializeAttestation(core, covenant, opener.publicKey, protocol.authority.publicKey)],
      [opener],
      `${NAMES[index]}: ballot`,
      "base",
    );
  }

  const delegationFor = (account: PublicKey) => ({
    buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(account, CORE_PROGRAM_ID),
    record: delegationRecordPdaFromDelegatedAccount(account),
    metadata: delegationMetadataPdaFromDelegatedAccount(account),
    delegationProgram: DELEGATION_PROGRAM_ID,
  });

  await send(
    base,
    [delegateIncident(opener.publicKey, covenant, incidentId, validator, delegationFor(core))],
    [opener],
    "delegate core",
    "base",
  );
  await send(
    base,
    [delegateClaim(opener.publicKey, core, validator, delegationFor(claim))],
    [opener],
    "delegate claim",
    "base",
  );
  for (const [index, protocol] of protocols.entries()) {
    const ballot = attestationAddress(core, protocol.authority.publicKey);
    await send(
      base,
      [
        delegateAttestation(
          opener.publicKey,
          core,
          protocol.authority.publicKey,
          validator,
          delegationFor(ballot),
        ),
      ],
      [opener],
      `delegate ${NAMES[index]}'s ballot`,
      "base",
    );
  }

  await send(
    er,
    [
      createClaimPermission(
        core,
        opener.publicKey,
        memberKeys.map((k) => interactionOnly(k)),
      ),
    ],
    [opener],
    "claim permission",
    "er",
  );
  for (const [index, protocol] of protocols.entries()) {
    await send(
      er,
      [createAttestationPermission(core, protocol.authority.publicKey)],
      [opener],
      `${NAMES[index]}'s ballot permission`,
      "er",
    );
  }

  const claimText = `VINCT-PHASE6-CLAIM-${RUN_LABEL}`;
  await send(
    er,
    [openIncident(core, opener.publicKey, memberKeys, sha256(claimText))],
    [opener],
    "open incident",
    "er",
  );
  await send(
    er,
    [
      submitPrivateClaim(core, opener.publicKey, {
        claim: Buffer.from(claimText, "utf8"),
        observationStart: 1n,
        observationEnd: 2n,
        notes: Buffer.from("", "utf8"),
      }),
    ],
    [opener],
    "private claim",
    "er",
  );
  say("  nobody answers, which is the whole point of this run");

  // -------------------------------------------------------------- the request

  const openedCore = await er.getAccountInfo(core);
  if (!openedCore) throw new Error("the incident core is not on the rollup");
  const taskId = expiryTaskId(decodeIncidentCore(openedCore.data));
  say(`\nRequesting the expiry task (id ${taskId})`);

  // Anything the core program did on the rollup before this point must not be counted as an
  // iteration. A watcher that started from zero would report the opening transaction as
  // scheduler activity.
  const beforeRequest = (await er.getSignaturesForAddress(CORE_PROGRAM_ID, { limit: 1 }))[0]
    ?.signature;

  const requestSignature = await send(
    er,
    [requestExpiryCrank(core, opener.publicKey, memberKeys, CRANK_INTERVAL_MS, CRANK_ITERATIONS)],
    [opener],
    "request expiry crank",
    "er",
  );
  say(
    `  ${CrankState.Requested} — the validator logged a request. Nothing is registered, and nothing has run.`,
  );

  let observation;
  if (CANCEL_RUN) {
    // Let a few iterations land first, so the cancellation is proven to have stopped something
    // that was actually running rather than something that never started.
    say("\nWaiting for the task to start before cancelling it");
    const running = await watchExpiryCrank(er, {
      taskId,
      program: CORE_PROGRAM_ID,
      incidentCore: core,
      requestSignature,
      since: beforeRequest ?? null,
      watchWindowMs: 30_000,
      observedAt: capturedAt,
    });
    say(`  ${running.state}, ${running.iterationSignatures.length} iterations observed`);
    if (running.iterationSignatures.length === 0) {
      throw new Error("no iteration was observed, so cancelling would prove nothing");
    }

    const cancelSignature = await send(
      er,
      [cancelExpiryCrank(core, opener.publicKey)],
      [opener],
      "cancel expiry crank",
      "er",
    );
    say(`  ${CrankState.CancellationRequested} — again a request, not a removal.`);

    observation = await watchCancellation(er, {
      taskId,
      program: CORE_PROGRAM_ID,
      incidentCore: core,
      requestSignature,
      cancelSignature,
      since: beforeRequest ?? null,
      quietWindowMs: QUIET_WINDOW_MS,
      requestedIterations: Number(CRANK_ITERATIONS),
      watchWindowMs: WATCH_WINDOW_MS,
      observedAt: capturedAt,
    });
    say(
      `  ${observation.state} — the iteration count held still for ${QUIET_WINDOW_MS}ms after the request.`,
    );
  } else {
    say("\nWatching the scheduler");
    observation = await watchExpiryCrank(er, {
      taskId,
      program: CORE_PROGRAM_ID,
      incidentCore: core,
      requestSignature,
      since: beforeRequest ?? null,
      watchWindowMs: WATCH_WINDOW_MS,
      observedAt: capturedAt,
    });
    say(`  iterations observed: ${observation.iterationSignatures.length}`);
    say(`  incident status: ${observation.incidentStatus}`);
    say(`  ${observation.state}`);
  }

  // Every iteration before the deadline had to be a no-op, and the incident had to be settled
  // by the scheduler rather than by anything in this script.
  const settledByCrank = !CANCEL_RUN && observation.desiredStateReached;

  say(`\nSafe to take the accounts off the rollup: ${safeToUndelegate(observation)}`);

  // ---------------------------------------------------- scrub, then undelegate

  let scrubHeld = false;
  let releaseMarker: string | undefined;
  if (safeToUndelegate(observation) && observation.desiredStateReached) {
    say("\nScrubbing and releasing");
    await send(er, [scrubClaim(core)], [payer], "scrub claim", "er");
    for (const [index, protocol] of protocols.entries()) {
      await send(
        er,
        [scrubAttestation(core, protocol.authority.publicKey)],
        [payer],
        `scrub ${NAMES[index]}'s ballot`,
        "er",
      );
    }
    await send(er, [closeClaimPermission(core)], [payer], "close claim permission", "er");
    for (const [index, protocol] of protocols.entries()) {
      await send(
        er,
        [closeAttestationPermission(core, protocol.authority.publicKey)],
        [payer],
        `close ${NAMES[index]}'s ballot permission`,
        "er",
      );
    }
    // The order the PRD requires: permissions closed, then the accounts leave. Undelegating
    // first would strand a permission on a rollup whose account has gone.
    await send(
      er,
      [releaseIncident(payer.publicKey, covenant, incidentId, memberKeys)],
      [payer],
      "release the incident family",
      "er",
    );
    releaseMarker = (await er.getSignaturesForAddress(CORE_PROGRAM_ID, { limit: 1 }))[0]?.signature;

    const deadline = Date.now() + 60_000;
    let released = null;
    while (Date.now() < deadline && !released) {
      const account = await base.getAccountInfo(core);
      if (account?.owner.equals(CORE_PROGRAM_ID)) released = account.data;
      else await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!released) throw new Error("the incident core never returned to base ownership");

    const claimAccount = await base.getAccountInfo(claim);
    const claimView = claimAccount ? decodeIncidentClaim(claimAccount.data) : null;
    const ballots = [];
    for (const protocol of protocols) {
      const account = await base.getAccountInfo(
        attestationAddress(core, protocol.authority.publicKey),
      );
      if (account) ballots.push(decodeMemberAttestation(account.data));
    }
    scrubHeld =
      claimView?.protectedRegionAllZero === true &&
      ballots.length === protocols.length &&
      ballots.every((b) => b.protectedRegionAllZero);
    say(`  released as ${IncidentStatus[decodeIncidentCore(released).status]}`);
    say(`  scrub verified on base: ${scrubHeld}`);
  }

  // What a task does after its accounts have left the rollup.
  //
  // VINCT cannot undelegate mid-collection: `release_incident` requires a terminal status. So
  // the exposure is narrower than the general case, and this is what it looks like. The task
  // is still scheduled, its accounts are gone, and the remaining iterations run against
  // nothing. They must not corrupt anything, and the run records what they actually did rather
  // than assuming.
  let afterRelease: { signature: string; succeeded: boolean; error: string | null }[] = [];
  if (releaseMarker) {
    await new Promise((resolve) => setTimeout(resolve, POST_RELEASE_WATCH_MS));
    afterRelease = await iterationOutcomes(er, CORE_PROGRAM_ID, releaseMarker);
    const failed = afterRelease.filter((o) => !o.succeeded).length;
    say(
      `\nIterations after the accounts left the rollup: ${afterRelease.length}, of which ${failed} failed`,
    );
    say("  A failed iteration here is expected and harmless. The incident already settled on");
    say("  base, and the handler has no account left to touch.");
  }

  // The task's own iterations after the incident went terminal. Every one must have been a
  // no-op, which is what makes leaving a finite task running safe.
  const trailing = await countIterations(er, CORE_PROGRAM_ID, beforeRequest ?? null);

  const expectedState = CANCEL_RUN ? CrankState.RemovalObserved : CrankState.DesiredStateReached;
  const verdict =
    observation.state === expectedState &&
    observation.iterationSignatures.length > 0 &&
    // A cancelled task that simply ran out of iterations proves nothing about the cancel.
    (CANCEL_RUN ? !observation.iterationsExhausted : settledByCrank && scrubHeld)
      ? "PASS"
      : "FAIL";
  say(`\nPhase 6 expiry (${RUN_LABEL}): ${verdict} — expected ${expectedState}`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    join(ARTIFACT_DIR, `phase6-expiry-${RUN_LABEL}.json`),
    `${JSON.stringify(
      {
        captured_at: capturedAt,
        run: RUN_LABEL,
        verdict,
        expected_state: expectedState,
        endpoints: { base: BASE_RPC, er: ER_RPC },
        validator_identity: validator.toBase58(),
        covenant: covenant.toBase58(),
        incident: core.toBase58(),
        task_id: taskId.toString(),
        response_window_slots: RESPONSE_WINDOW_SLOTS.toString(),
        requested: {
          execution_interval_millis: CRANK_INTERVAL_MS.toString(),
          iterations: CRANK_ITERATIONS.toString(),
          note: "A requested iteration count is not a delivered one. See docs/decision-log.md D-0059.",
        },
        observation,
        trailing_iteration_count: trailing.length,
        iterations_after_release: afterRelease,
        iterations_after_release_note:
          "VINCT cannot undelegate an incident that is still collecting, because release_incident requires a terminal status. These are the iterations that outlived the release, and they touch accounts that are no longer on the rollup.",
        settled_by_the_scheduler: settledByCrank,
        scrub_verified_on_base: scrubHeld,
        safe_to_undelegate: safeToUndelegate(observation),
        state_machine: Object.values(CrankState),
        means:
          "A schedule or cancel transaction is REQUESTED. Every later state was read from the rollup, and registration is inferred from an observed execution because this validator exposes no task registry.",
        steps,
        transcript: log,
      },
      null,
      2,
    )}\n`,
  );
  say(`\nWrote artifacts/local-stack/phase6-expiry-${RUN_LABEL}.json`);
  if (verdict !== "PASS") process.exitCode = 1;
}

await main();

/**
 * The whole VINCT mechanism, end to end, on the local MagicBlock stack.
 *
 * Covenant formation, ratification, and arming; an incident opened under it; a private claim
 * and sealed attestations inside the rollup; certification counted in memory; the terminal
 * scrub; the release back to base; the certificate that certification earned; and the Magic
 * Action cohort that certificate authorises.
 *
 * Nothing is manufactured. The certificate comes from an incident that reached its covenant's
 * threshold, and the operation ID the cohort settles under is the one the program derived at
 * certification. That is the difference between this and the Phase 3 seam, which chose an
 * operation ID up front and published a certificate to match.
 *
 * The classification is read from base-layer account state, never from a scheduling
 * signature. An ER signature means an intent was accepted; it says nothing about whether any
 * BaseAction ran. See docs/decision-log.md D-0027 and D-0031.
 *
 *   bash scripts/bootstrap-local.sh start
 *   pnpm exec tsx scripts/phase5-composition.ts
 *   pnpm exec tsx scripts/phase5-composition.ts --fail-one
 *   pnpm exec tsx scripts/phase5-composition.ts --suspend-one
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  createTopUpEscrowInstruction,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  escrowPdaFromEscrowAuthority,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { verifyOperation } from "../packages/verifier/src/index.js";
import {
  SettlementClassification,
  reconcile,
  recoveryVerdict,
} from "../packages/monitor/src/index.js";
import {
  ADAPTER_PROGRAM_ID,
  CORE_PROGRAM_ID,
  Decision,
  IncidentStatus,
  MOCK_PROTOCOL_PROGRAM_ID,
  MemberRole,
  actionTemplateHash,
  adapterReceiptAddress,
  adapterSignerAddress,
  addCovenantMember,
  armCapability,
  armCovenant,
  armCovenantMember,
  attestationAddress,
  authenticate,
  canonicalMemberOrder,
  capabilityAddress,
  certificateAddress,
  certifyIncident,
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
  delegateOperation,
  executeBoundedActionTemplate,
  incidentAddress,
  initializeAdapterReceipt,
  initializeAttestation,
  initializeClaim,
  initializeIncident,
  initializeMarket,
  initializeOperation,
  initializeSettlementReceipt,
  installCapability,
  interactionOnly,
  marketAddress,
  openIncident,
  operationAddress,
  publishCertificate,
  ratifyCovenant,
  ratifyCovenantMember,
  releaseIncident,
  scheduleSettlementCohort,
  scrubAttestation,
  scrubClaim,
  setAdapter,
  settlementReceiptAddress,
  submitPrivateClaim,
  submitSealedAttestation,
  suspendCapability,
} from "../packages/client/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "local-stack");

const BASE_RPC = process.env.VINCT_BASE_RPC ?? "http://127.0.0.1:8899";
const ER_RPC = process.env.VINCT_ER_RPC ?? "http://127.0.0.1:7799";
const QFS_RPC = process.env.VINCT_QFS_RPC ?? "http://127.0.0.1:6699";

/** Leaves one protocol without a registered adapter signer, so its BaseAction fails. */
const FAIL_ONE = process.argv.includes("--fail-one");
/** Suspends one capability after certification, before the cohort runs. */
const SUSPEND_ONE = process.argv.includes("--suspend-one");
const RUN_LABEL = FAIL_ONE ? "fail-one" : SUSPEND_ONE ? "suspend-one" : "success";

const ADAPTER_ACTION_CU = 90_000;
const SETTLEMENT_ACTION_CU = 40_000;
const OBSERVATION_WINDOW_MS = 90_000;
const OBSERVATION_INTERVAL_MS = 2_000;

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
  detail?: unknown;
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

function record(step: Step): void {
  steps.push(step);
  say(`  ${step.step}`);
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

  const steward = derived(`phase5:${RUN_LABEL}:steward`);
  const authorities = NAMES.map((name) => ({
    name,
    authority: derived(`phase5:${RUN_LABEL}:protocol:${name}`),
  }));
  const memberKeys = authorities.map((p) => p.authority.publicKey);

  for (const keypair of [steward, ...authorities.map((p) => p.authority)]) {
    await base.confirmTransaction(
      await base.requestAirdrop(keypair.publicKey, 10_000_000_000),
      "confirmed",
    );
  }

  // Keys are derived from the run label so a failed run can be inspected at a known address.
  // That also means a second run on the same ledger would collide, so the covenant ID walks
  // forward to the first one nobody has used. Reruns are the normal case while iterating, and
  // a script that needs the validator restarted first is a script people stop running.
  let covenantId = 1n;
  while (await base.getAccountInfo(covenantAddress(steward.publicKey, covenantId))) {
    covenantId += 1n;
    if (covenantId > 64n) throw new Error("no free covenant id; restart the local validator");
  }
  const covenant = covenantAddress(steward.publicKey, covenantId);
  // Markets are seeded per covenant so a rerun brings up fresh ones rather than colliding.
  const protocols = authorities.map((protocol, index) => ({
    ...protocol,
    marketId: covenantId * 16n + BigInt(index + 1),
  }));
  const policyId = sha256(`phase5:${RUN_LABEL}:policy`);
  const templateHashSeed = sha256(`phase5:${RUN_LABEL}:bundle-template`);
  const incidentId = 1n;
  const core = incidentAddress(covenant, incidentId);
  const claim = claimAddress(core);

  say(`VINCT Phase 5 — full composition on the local stack (${RUN_LABEL})`);
  say(`  base ${BASE_RPC}   er ${ER_RPC}   qfs ${QFS_RPC}`);
  say(`  covenant ${covenant.toBase58()}`);
  say(`  incident ${core.toBase58()}`);
  say("");

  // ------------------------------------------------------- covenant formation

  say("Forming the covenant");
  await send(
    base,
    [
      createCovenant(steward.publicKey, {
        covenantId,
        circleEpoch: 1n,
        clusterGenesisHash,
        policyId,
        actionBundleTemplateHash: templateHashSeed,
        requiredApprovals: 2,
        maximumRejections: 1,
        responseWindowSlots: 200_000n,
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
      `${protocol.name} arms its membership`,
      "base",
    );
  }
  await send(base, [armCovenant(covenant)], [payer], "covenant arms", "base");

  // -------------------------------------------- protocol markets and capabilities

  say("\nEach protocol brings up its own market and arms its own capability");
  const slot = BigInt(await base.getSlot());
  const validFrom = slot > 1_000n ? slot - 1_000n : 0n;
  const expiresAt = slot + 5_000_000n;
  const executeDataHash = sha256(Buffer.from([174, 108, 103, 144, 85, 165, 195, 31]));

  const armed = protocols.map((protocol) => {
    const market = marketAddress(protocol.authority.publicKey, protocol.marketId);
    const capability = capabilityAddress(protocol.authority.publicKey, covenant, policyId);
    return {
      ...protocol,
      market,
      capability,
      adapterSigner: adapterSignerAddress(capability),
    };
  });

  for (const [index, protocol] of armed.entries()) {
    await send(
      base,
      [initializeMarket(protocol.market, protocol.authority.publicKey, protocol.marketId, null)],
      [protocol.authority],
      `${protocol.name}: market`,
      "base",
    );

    // The template commits to the shape, not to an operation. Nothing here knows about any
    // incident, which is the whole point: a protocol arms before the crisis.
    const templateHash = actionTemplateHash(
      executeBoundedActionTemplate(
        protocol.capability,
        protocol.market,
        protocol.adapterSigner,
        MOCK_PROTOCOL_PROGRAM_ID,
      ),
    );
    await send(
      base,
      [
        installCapability(protocol.capability, protocol.authority.publicKey, {
          protocolState: protocol.market,
          coreProgram: CORE_PROGRAM_ID,
          adapterVersion: 1,
          clusterGenesisHash,
          covenant,
          circleEpoch: 1n,
          policyId,
          memberSetHash: (await readCovenantMemberSetHash(base, covenant)) as Uint8Array,
          actionCategory: 0,
          targetProgram: MOCK_PROTOCOL_PROGRAM_ID,
          instructionDiscriminator: sha256("global:pause_new_borrowing").slice(0, 8),
          actionTemplateHash: templateHash,
          instructionDataHash: executeDataHash,
          maxEffect: { mayPause: true, mayUnpause: false, maxValueMoved: 0n },
          validFromSlot: validFrom,
          expiresAtSlot: expiresAt,
        }),
      ],
      [protocol.authority],
      `${protocol.name}: install capability`,
      "base",
    );
    await send(
      base,
      [armCapability(protocol.capability, protocol.authority.publicKey, 1)],
      [protocol.authority],
      `${protocol.name}: arm capability`,
      "base",
    );

    // The deliberate failure: gamma never registers its adapter signer, so its BaseAction
    // cannot pause anything.
    const registers = !(FAIL_ONE && index === 2);
    await send(
      base,
      [
        setAdapter(
          protocol.market,
          protocol.authority.publicKey,
          registers ? protocol.adapterSigner : null,
        ),
      ],
      [protocol.authority],
      `${protocol.name}: ${registers ? "register adapter signer" : "LEAVE UNREGISTERED (deliberate failure)"}`,
      "base",
    );
  }

  // ------------------------------------------------------------- the incident

  const opener = protocols[0]!.authority;
  say("\nOpening the incident under the armed covenant");
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

  say("\nDelegating the incident family");
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

  say("\nCreating permissions and running the incident");
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

  const claimText = `VINCT-PHASE5-CLAIM-${RUN_LABEL}`;
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
        notes: Buffer.from(`VINCT-PHASE5-NOTES-${RUN_LABEL}`, "utf8"),
      }),
    ],
    [opener],
    "private claim",
    "er",
  );
  for (const [index, protocol] of protocols.slice(0, 2).entries()) {
    await send(
      er,
      [
        submitSealedAttestation(
          core,
          protocol.authority.publicKey,
          Decision.Approve,
          BigInt(index) + 1n,
        ),
      ],
      [protocol.authority],
      `${NAMES[index]}: sealed attestation`,
      "er",
    );
  }
  say(`  ${NAMES[2]} stays silent, and certification must not wait for it`);

  await send(er, [certifyIncident(core, memberKeys)], [payer], "certify", "er");

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
  await send(
    er,
    [releaseIncident(payer.publicKey, covenant, incidentId, memberKeys)],
    [payer],
    "release the incident family",
    "er",
  );

  // ------------------------------------------------------ back on the base layer

  say("\nWaiting for the incident to land back on base");
  const released = await waitForOwner(base, core, CORE_PROGRAM_ID, OBSERVATION_WINDOW_MS);
  if (!released) throw new Error("the incident core never returned to base ownership");
  const coreView = decodeIncidentCore(released);
  const operationId = coreView.operationId;
  record({
    step: `incident released: ${IncidentStatus[coreView.status]}, ${coreView.approvalCountAfterTerminal} approvals, operation ${Buffer.from(operationId).toString("hex").slice(0, 16)}…`,
    runtime: "none",
  });

  say("\nPublishing the certificate the incident earned");
  await send(
    base,
    [publishCertificate(payer.publicKey, core, operationId)],
    [payer],
    "publish certificate",
    "base",
  );

  // ------------------------------------------------------------- the cohort

  say("\nBuilding the cohort from the operation certification derived");
  await send(
    base,
    [initializeSettlementReceipt(payer.publicKey, operationId)],
    [payer],
    "settlement receipt",
    "base",
  );
  for (const [index, protocol] of armed.entries()) {
    await send(
      base,
      [initializeAdapterReceipt(payer.publicKey, protocol.capability, operationId)],
      [payer],
      `${NAMES[index]}: adapter receipt`,
      "base",
    );
  }

  if (SUSPEND_ONE) {
    const victim = armed[2]!;
    await send(
      base,
      [suspendCapability(victim.capability, victim.authority.publicKey)],
      [victim.authority],
      `${victim.name}: SUSPENDS ITS CAPABILITY AFTER CERTIFICATION`,
      "base",
    );
  }

  const escrow = escrowPdaFromEscrowAuthority(payer.publicKey);
  await send(
    base,
    [createTopUpEscrowInstruction(escrow, payer.publicKey, payer.publicKey, 50_000_000)],
    [payer],
    "top up the action escrow",
    "base",
  );

  await send(
    base,
    [initializeOperation(payer.publicKey, operationId, armed.length + 1)],
    [payer],
    "settlement operation",
    "base",
  );
  const operation = operationAddress(operationId);
  await send(
    base,
    [
      delegateOperation(payer.publicKey, operationId, validator, {
        buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(operation, CORE_PROGRAM_ID),
        record: delegationRecordPdaFromDelegatedAccount(operation),
        metadata: delegationMetadataPdaFromDelegatedAccount(operation),
        delegationProgram: DELEGATION_PROGRAM_ID,
      }),
    ],
    [payer],
    "delegate the operation",
    "base",
  );

  const schedulingSignature = await send(
    er,
    [
      scheduleSettlementCohort(
        {
          payer: payer.publicKey,
          operationId,
          magicContext: MAGIC_CONTEXT_ID,
          magicProgram: MAGIC_PROGRAM_ID,
          adapters: armed.map((protocol) => ({
            capability: protocol.capability,
            protocolState: protocol.market,
            adapterReceipt: adapterReceiptAddress(operationId, protocol.capability),
            adapterSigner: protocol.adapterSigner,
          })),
        },
        ADAPTER_ACTION_CU,
        SETTLEMENT_ACTION_CU,
      ),
    ],
    [payer],
    "schedule the cohort",
    "er",
  );
  record({
    step: "INTENT_ACCEPTED — a scheduling signature, and nothing more. Every effect below is read from base.",
    runtime: "none",
    detail: schedulingSignature,
  });

  // ------------------------------------------------- independent observation

  // The classification comes from the settlement monitor, which reads base-layer state and is
  // checked against the Rust classifier on all 729 observations of a two-action cohort. The
  // script deliberately owns none of this logic: a runner that classifies its own run is a
  // runner that can be made to pass.
  say("\nObserving base-layer effects");
  const settlement = await reconcile(
    base,
    {
      operationId,
      certificate: certificateAddress(operationId),
      settlementReceipt: settlementReceiptAddress(operationId),
      actions: armed.map((protocol, index) => ({
        actionIndex: index,
        label: protocol.name,
        adapterReceipt: adapterReceiptAddress(operationId, protocol.capability),
        targetState: protocol.market,
      })),
    },
    schedulingSignature,
    {
      observationWindowMs: OBSERVATION_WINDOW_MS,
      intervalMs: OBSERVATION_INTERVAL_MS,
      observedAt: capturedAt,
    },
  );
  for (const action of settlement.observation.actions) {
    say(
      `  ${action.label}: receipt=${action.receipt} effect=${action.targetEffect} (${action.deliveryState})`,
    );
  }
  say(`  certificate checkpoint=${settlement.observation.certificateCheckpoint}`);
  say(`  settlement receipt=${settlement.observation.settlementReceipt}`);

  const classification = settlement.classification;
  say(`\nClassification: ${classification} -> ${settlement.status}`);
  say(`Recovery: ${recoveryVerdict(settlement)}`);

  // ------------------------------------------------- privacy still holds on base

  const claimAccount = await base.getAccountInfo(claim);
  const claimView = claimAccount ? decodeIncidentClaim(claimAccount.data) : null;
  const ballotViews = [];
  for (const protocol of protocols) {
    const account = await base.getAccountInfo(
      attestationAddress(core, protocol.authority.publicKey),
    );
    if (account) ballotViews.push(decodeMemberAttestation(account.data));
  }
  const scrubHeld =
    claimView?.protectedRegionAllZero === true &&
    ballotViews.length === protocols.length &&
    ballotViews.every((b) => b.protectedRegionAllZero);
  say(`Scrub verified on base: ${scrubHeld}`);

  // The standalone verifier, run against the same chain, re-deriving the operation ID from the
  // covenant's terms with an implementation that shares no code with the program. If this
  // disagrees, the run is not evidence of anything regardless of what settled.
  say("\nIndependent verification");
  const verification = await verifyOperation(base, {
    incidentCore: core,
    certificate: certificateAddress(operationId),
    settlementReceipt: settlementReceiptAddress(operationId),
    adapterReceipts: armed.map((protocol) => ({
      label: protocol.name,
      address: adapterReceiptAddress(operationId, protocol.capability),
    })),
  });
  for (const check of verification.checks) {
    if (!check.passed) say(`  FAIL ${check.name}: ${check.detail}`);
  }
  say(
    `  ${verification.checks.length} checks, ${verification.verified ? "VERIFIED" : "NOT VERIFIED"}`,
  );

  const expected =
    FAIL_ONE || SUSPEND_ONE
      ? SettlementClassification.CommitWithoutActions
      : SettlementClassification.AllActionsApplied;
  const verdict =
    classification === expected && scrubHeld && verification.verified ? "PASS" : "FAIL";
  say(`\nPhase 5 composition (${RUN_LABEL}): ${verdict} — expected ${expected}`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const body = `${JSON.stringify(
    {
      captured_at: capturedAt,
      run: RUN_LABEL,
      verdict,
      expected_classification: expected,
      observed_classification: classification,
      note: "The certificate was earned by an incident that reached its covenant's threshold. The operation ID is the one the program derived at certification. Nothing here was manufactured.",
      endpoints: { base: BASE_RPC, er: ER_RPC, qfs: QFS_RPC },
      covenant: covenant.toBase58(),
      incident: core.toBase58(),
      operation_id: Buffer.from(operationId).toString("hex"),
      certificate: certificateAddress(operationId).toBase58(),
      settlement_receipt: settlementReceiptAddress(operationId).toBase58(),
      adapter_receipts: armed.map((protocol) => ({
        label: protocol.name,
        address: adapterReceiptAddress(operationId, protocol.capability).toBase58(),
      })),
      incident_outcome: {
        status: IncidentStatus[coreView.status],
        approvals: coreView.approvalCountAfterTerminal,
        rejections: coreView.rejectionCountAfterTerminal,
      },
      independent_verification: verification,
      settlement_record: settlement,
      scrub_verified_on_base: scrubHeld,
      recovery_verdict: recoveryVerdict(settlement),
      scheduling_means:
        "INTENT_ACCEPTED. A scheduling signature is not settlement, and no effect above was inferred from it. The classification comes from packages/monitor, which is checked against the Rust classifier on every observation of a two-action cohort.",
      steps,
      transcript: log,
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(ARTIFACT_DIR, `phase5-composition-${RUN_LABEL}.json`), body);
  say(`\nWrote artifacts/local-stack/phase5-composition-${RUN_LABEL}.json`);
  if (verdict !== "PASS") process.exitCode = 1;
}

/** The covenant's frozen member set, which a capability has to be armed against. */
async function readCovenantMemberSetHash(
  base: Connection,
  covenant: PublicKey,
): Promise<Uint8Array> {
  const account = await base.getAccountInfo(covenant);
  if (!account) throw new Error("the covenant does not exist yet");
  const { decodeCovenant } = await import("../packages/client/src/covenant.js");
  return decodeCovenant(account.data).memberSetHash;
}

async function waitForOwner(
  base: Connection,
  address: PublicKey,
  owner: PublicKey,
  windowMs: number,
): Promise<Buffer | null> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const account = await base.getAccountInfo(address);
    if (account?.owner.equals(owner)) return account.data;
    await new Promise((resolve) => setTimeout(resolve, OBSERVATION_INTERVAL_MS));
  }
  return null;
}

await main();

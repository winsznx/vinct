/**
 * The Phase 3 Magic Actions seam.
 *
 * This is the PRD's kill gate, so the script is written to produce evidence rather than a
 * verdict. It records what it observed, including the things it could not establish, and
 * writes the whole run to `artifacts/devnet/phase3-seam-<stamp>.json`.
 *
 * What it deliberately never does: infer that an action ran. Every effect is read back from
 * base-layer account state after the fact. A successful ER scheduling signature is recorded
 * as `INTENT_ACCEPTED` and nothing more.
 *
 *   pnpm exec tsx scripts/phase3-seam.ts             # success cohort
 *   pnpm exec tsx scripts/phase3-seam.ts --fail-one  # one adapter deliberately fails
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTopUpEscrowInstruction,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  DELEGATION_PROGRAM_ID,
  escrowPdaFromEscrowAuthority,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

import {
  ADAPTER_PROGRAM_ID,
  CORE_PROGRAM_ID,
  MOCK_PROTOCOL_PROGRAM_ID,
  adapterReceiptAddress,
  adapterSignerAddress,
  armCapability,
  capabilityAddress,
  certificateAddress,
  decodeAdapterReceipt,
  decodeMarket,
  decodeOperation,
  decodeSettlementReceipt,
  delegateOperation,
  executeBoundedActionAccounts,
  initializeAdapterReceipt,
  initializeMarket,
  initializeOperation,
  initializeSettlementReceipt,
  installCapability,
  marketAddress,
  operationAddress,
  resolveEphemeralEndpoint,
  scheduleSettlementCohort,
  setAdapter,
  settlementReceiptAddress,
} from "../packages/client/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "devnet");

const BASE_RPC = process.env.VINCT_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
/** The local stack has no router, so routing falls back to the configured endpoint. */
const ROUTER =
  process.env.VINCT_ROUTER === ""
    ? null
    : (process.env.VINCT_ROUTER ?? "https://devnet-router.magicblock.app/");
const KEYPAIR = process.env.VINCT_KEYPAIR ?? ".toolchain/keys/devnet-deployer.json";
const NETWORK_LABEL = process.env.VINCT_NETWORK ?? "solana-devnet";
const VALIDATOR = process.env.VINCT_VALIDATOR ?? null;
const FAIL_ONE = process.argv.includes("--fail-one");

const ADAPTER_ACTION_CU = 80_000;
const SETTLEMENT_ACTION_CU = 40_000;
/** How long to wait for base-layer effects before recording what was and was not seen. */
const OBSERVATION_WINDOW_MS = 90_000;
const OBSERVATION_INTERVAL_MS = 3_000;

interface Step {
  step: string;
  signature?: string;
  runtime: "base" | "er" | "none";
  detail?: unknown;
}

const steps: Step[] = [];
function record(step: Step): void {
  steps.push(step);
  const where = step.runtime === "none" ? "" : ` [${step.runtime}]`;
  console.log(`  ${step.step}${where}${step.signature ? ` ${step.signature}` : ""}`);
}

function sha256(input: Buffer | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

/** Derives a deterministic throwaway keypair so a rerun reuses the same fixture accounts. */
function derivedKeypair(seed: string): Keypair {
  return Keypair.fromSeed(sha256(seed).slice(0, 32));
}

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
  record({ step: label, signature, runtime });
  return signature;
}

/** Sends and tolerates an already-exists failure, so the script is rerunnable. */
async function sendIdempotent(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string | null> {
  try {
    return await send(connection, instructions, signers, label, "base");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("already in use") || message.includes("custom program error: 0x0")) {
      record({ step: `${label} (already existed)`, runtime: "none" });
      return null;
    }
    throw cause;
  }
}

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString();
  const base = new Connection(BASE_RPC, "confirmed");
  const payer = loadKeypair(join(REPO_ROOT, KEYPAIR));

  // The cluster genesis hash is read from the chain being used, never from a constant, so a
  // certificate minted here can never be replayed onto a different cluster.
  const genesisHash = await base.getGenesisHash();
  const clusterGenesisHash = new PublicKey(genesisHash).toBytes();

  // One covenant, three protocols. A distinct run label keeps reruns from colliding on the
  // certificate PDA, which is seeded by the operation ID.
  const runLabel = process.env.VINCT_RUN_LABEL ?? (FAIL_ONE ? "phase3-fail" : "phase3-success");
  const covenant = derivedKeypair(`${runLabel}:covenant`).publicKey;
  const policyId = sha256(`${runLabel}:policy`);
  const memberSetHash = sha256(`${runLabel}:members`);
  const operationId = sha256(`${runLabel}:operation`);

  console.log(`VINCT Phase 3 seam — ${runLabel}`);
  console.log(`  base     ${BASE_RPC}`);
  console.log(`  router   ${ROUTER}`);
  console.log(`  payer    ${payer.publicKey.toBase58()}`);
  console.log(`  covenant ${covenant.toBase58()}`);
  console.log(`  op       ${Buffer.from(operationId).toString("hex")}`);
  console.log("");

  const names = ["alpha", "beta", "gamma"] as const;
  const protocols = names.map((name, index) => {
    const authority = derivedKeypair(`${runLabel}:authority:${name}`);
    const marketId = BigInt(index + 1);
    const market = marketAddress(authority.publicKey, marketId);
    const capability = capabilityAddress(authority.publicKey, covenant, policyId);
    return {
      name,
      authority,
      marketId,
      market,
      capability,
      adapterSigner: adapterSignerAddress(capability),
      receipt: adapterReceiptAddress(operationId, capability),
    };
  });

  // ---------------------------------------------------------------- funding

  console.log("Funding protocol authorities");
  const fundingAmount = 8_000_000;
  const fundingInstructions: TransactionInstruction[] = [];
  for (const protocol of protocols) {
    const balance = await base.getBalance(protocol.authority.publicKey);
    if (balance < fundingAmount / 2) {
      const { SystemProgram } = await import("@solana/web3.js");
      fundingInstructions.push(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: protocol.authority.publicKey,
          lamports: fundingAmount,
        }),
      );
    }
  }
  if (fundingInstructions.length > 0) {
    await send(base, fundingInstructions, [payer], "fund authorities", "base");
  } else {
    record({ step: "authorities already funded", runtime: "none" });
  }

  // -------------------------------------------------------- protocol fixture

  console.log("\nBringing three protocols to armed");
  const slot = BigInt(await base.getSlot());
  const validFrom = slot > 1000n ? slot - 1000n : 0n;
  const expiresAt = slot + 5_000_000n;

  const executeDataHash = sha256(Buffer.from([174, 108, 103, 144, 85, 165, 195, 31]));

  for (const protocol of protocols) {
    await sendIdempotent(
      base,
      [initializeMarket(protocol.market, protocol.authority.publicKey, protocol.marketId, null)],
      [protocol.authority],
      `${protocol.name}: initialize market`,
    );

    // The commitment covers the six accounts the adapter declares, in its declared order,
    // and deliberately excludes the escrow pair the #[action] macro appends.
    const metas = executeBoundedActionAccounts(operationId, protocol.capability, protocol.market);
    const metasHash = (() => {
      const hasher = createHash("sha256");
      const count = Buffer.alloc(4);
      count.writeUInt32LE(metas.length);
      hasher.update(count);
      for (const meta of metas) {
        hasher.update(meta.pubkey.toBuffer());
        hasher.update(Buffer.from([meta.isSigner ? 1 : 0]));
        hasher.update(Buffer.from([meta.isWritable ? 1 : 0]));
      }
      return new Uint8Array(hasher.digest());
    })();

    await sendIdempotent(
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
          memberSetHash,
          actionCategory: 0,
          targetProgram: MOCK_PROTOCOL_PROGRAM_ID,
          instructionDiscriminator: sha256("global:pause_new_borrowing").slice(0, 8),
          orderedAccountMetasHash: metasHash,
          instructionDataHash: executeDataHash,
          maxEffect: { mayPause: true, mayUnpause: false, maxValueMoved: 0n },
          validFromSlot: validFrom,
          expiresAtSlot: expiresAt,
        }),
      ],
      [protocol.authority],
      `${protocol.name}: install capability`,
    );

    await sendIdempotent(
      base,
      [armCapability(protocol.capability, protocol.authority.publicKey, 1)],
      [protocol.authority],
      `${protocol.name}: arm capability`,
    );

    // The failure case: gamma never registers its adapter signer, so its CPI into the
    // protocol fails inside the target program. That is a realistic failure — a protocol
    // that withdrew consent — rather than a synthetic error injected into the adapter.
    const registerSigner = !(FAIL_ONE && protocol.name === "gamma");
    await sendIdempotent(
      base,
      [
        setAdapter(
          protocol.market,
          protocol.authority.publicKey,
          registerSigner ? protocol.adapterSigner : null,
        ),
      ],
      [protocol.authority],
      `${protocol.name}: ${registerSigner ? "register adapter signer" : "LEAVE ADAPTER UNREGISTERED (deliberate failure)"}`,
    );
  }

  // ------------------------------------------------------------ certificate

  // Since Phase 5 a certificate can only come from an incident that reached its covenant's
  // threshold inside the private runtime. This script is the cohort probe: it measures what
  // Magic Actions does with a certificate that already exists, and it cannot manufacture one.
  //
  // `scripts/phase5-lifecycle.ts` runs the whole sequence and produces the certificate this
  // one consumes.
  console.log("\nChecking the certificate this cohort settles against");
  const certificate = certificateAddress(operationId);
  if ((await base.getAccountInfo(certificate)) === null) {
    throw new Error(
      `no certificate at ${certificate.toBase58()} for operation ${Buffer.from(operationId).toString("hex")}. ` +
        "Certificates are earned by an incident, not published on request. Run scripts/phase5-lifecycle.ts first.",
    );
  }
  record({ step: "certificate present", runtime: "none", detail: certificate.toBase58() });

  console.log("\nCreating every receipt up front");
  await sendIdempotent(
    base,
    [initializeSettlementReceipt(payer.publicKey, operationId)],
    [payer],
    "initialize settlement receipt",
  );

  for (const protocol of protocols) {
    await sendIdempotent(
      base,
      [initializeAdapterReceipt(payer.publicKey, protocol.capability, operationId)],
      [payer],
      `${protocol.name}: initialize adapter receipt`,
    );
  }

  await sendIdempotent(
    base,
    [initializeOperation(payer.publicKey, operationId, protocols.length + 1)],
    [payer],
    "initialize settlement operation",
  );

  // ---------------------------------------------------- escrow and delegation

  console.log("\nFunding the action escrow and delegating the operation account");
  const escrow = escrowPdaFromEscrowAuthority(payer.publicKey);
  await sendIdempotent(
    base,
    [createTopUpEscrowInstruction(escrow, payer.publicKey, payer.publicKey, 20_000_000)],
    [payer],
    "top up action escrow",
  );

  const operation = operationAddress(operationId);
  const operationAccountBefore = await base.getAccountInfo(operation);
  const alreadyDelegated =
    operationAccountBefore?.owner.toBase58() === DELEGATION_PROGRAM_ID.toBase58();

  if (!alreadyDelegated) {
    await send(
      base,
      [
        delegateOperation(
          payer.publicKey,
          operationId,
          VALIDATOR ? new PublicKey(VALIDATOR) : null,
          {
            buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
              operation,
              CORE_PROGRAM_ID,
            ),
            record: delegationRecordPdaFromDelegatedAccount(operation),
            metadata: delegationMetadataPdaFromDelegatedAccount(operation),
            delegationProgram: DELEGATION_PROGRAM_ID,
          },
        ),
      ],
      [payer],
      "delegate operation account",
      "base",
    );
  } else {
    record({ step: "operation account already delegated", runtime: "none" });
  }

  const afterDelegation = await base.getAccountInfo(operation);
  const delegationOwner = afterDelegation?.owner.toBase58() ?? null;
  record({
    step: "base owner after delegation",
    runtime: "none",
    detail: {
      owner: delegationOwner,
      isDelegationProgram: delegationOwner === DELEGATION_PROGRAM_ID.toBase58(),
    },
  });

  // ------------------------------------------------------- routing (D-0009)

  console.log("\nResolving the ephemeral rollup endpoint for a genuinely delegated account");
  const resolution = await resolveEphemeralEndpoint({
    router: ROUTER,
    baseConnection: base,
    delegatedAccount: operation,
    delegationRecord: delegationRecordPdaFromDelegatedAccount(operation),
    configuredEndpoint: process.env.VINCT_ER_ENDPOINT ?? null,
  });
  console.log(`  source   ${resolution.source}`);
  console.log(`  endpoint ${resolution.endpoint ?? "<unresolved>"}`);
  console.log(`  status   {${resolution.evidence.delegationStatusFields.join(", ")}}`);
  console.log(`  note     ${resolution.evidence.note}`);
  record({ step: "resolve ER endpoint", runtime: "none", detail: resolution });

  if (!resolution.endpoint) {
    throw new Error("no ephemeral rollup endpoint could be resolved");
  }

  // ------------------------------------------------------------- scheduling

  console.log("\nScheduling the cohort on the ephemeral rollup");
  const er = new Connection(resolution.endpoint, "confirmed");
  const erOwner = await er.getAccountInfo(operation);
  record({
    step: "ER owner before scheduling",
    runtime: "none",
    detail: {
      owner: erOwner?.owner.toBase58() ?? null,
      isCoreProgram: erOwner?.owner.toBase58() === CORE_PROGRAM_ID.toBase58(),
    },
  });

  const cohortInstruction = scheduleSettlementCohort(
    {
      payer: payer.publicKey,
      operationId,
      magicContext: MAGIC_CONTEXT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
      adapters: protocols.map((protocol) => ({
        capability: protocol.capability,
        protocolState: protocol.market,
        adapterReceipt: protocol.receipt,
        adapterSigner: protocol.adapterSigner,
      })),
    },
    ADAPTER_ACTION_CU,
    SETTLEMENT_ACTION_CU,
  );

  const measuredTransaction = new Transaction().add(cohortInstruction);
  measuredTransaction.feePayer = payer.publicKey;
  measuredTransaction.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const serializedSize = measuredTransaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).length;

  const erSignature = await send(er, [cohortInstruction], [payer], "schedule cohort", "er");
  const scheduledAt = Date.now();

  // The single most important line in this script. A scheduling signature means the intent
  // was accepted. Nothing about base-layer delivery is known yet.
  console.log("\n  state: INTENT_ACCEPTED (not settled, not attempted, not observed)");

  const erTransaction = await er.getTransaction(erSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const erComputeUnits = erTransaction?.meta?.computeUnitsConsumed ?? null;

  // -------------------------------------------------------- observation loop

  console.log("\nObserving base-layer effects. Nothing below is inferred.");
  interface Observation {
    marketPaused: boolean | null;
    marketUpdateCount: string | null;
    marketLastOperation: string | null;
    receiptExecuted: boolean | null;
    receiptTargetApplied: boolean | null;
  }

  const readEffects = async (): Promise<{
    adapters: Record<string, Observation>;
    settlementFinalized: boolean | null;
    settlementObservedActionCount: number | null;
    operationStillDelegated: boolean | null;
    operationScheduledFlag: boolean | null;
  }> => {
    const adapters: Record<string, Observation> = {};
    for (const protocol of protocols) {
      const marketInfo = await base.getAccountInfo(protocol.market);
      const receiptInfo = await base.getAccountInfo(protocol.receipt);
      const market = marketInfo ? decodeMarket(marketInfo.data) : null;
      const receipt = receiptInfo ? decodeAdapterReceipt(receiptInfo.data) : null;
      adapters[protocol.name] = {
        marketPaused: market?.newBorrowingPaused ?? null,
        marketUpdateCount: market ? market.updateCount.toString() : null,
        marketLastOperation: market ? Buffer.from(market.lastOperationId).toString("hex") : null,
        receiptExecuted: receipt?.executed ?? null,
        receiptTargetApplied: receipt?.targetEffectApplied ?? null,
      };
    }
    const settlementInfo = await base.getAccountInfo(settlementReceiptAddress(operationId));
    const settlement = settlementInfo ? decodeSettlementReceipt(settlementInfo.data) : null;
    const operationInfo = await base.getAccountInfo(operation);
    const stillDelegated =
      operationInfo === null
        ? null
        : operationInfo.owner.toBase58() === DELEGATION_PROGRAM_ID.toBase58();
    const operationDecoded =
      operationInfo && !stillDelegated ? decodeOperation(operationInfo.data) : null;

    return {
      adapters,
      settlementFinalized: settlement?.finalized ?? null,
      settlementObservedActionCount: settlement?.observedActionCount ?? null,
      operationStillDelegated: stillDelegated,
      operationScheduledFlag: operationDecoded?.scheduled ?? null,
    };
  };

  let effects = await readEffects();
  const deadline = scheduledAt + OBSERVATION_WINDOW_MS;
  let firstEffectAt: number | null = null;
  while (Date.now() < deadline) {
    const complete =
      effects.settlementFinalized === true &&
      protocols.every((p) => effects.adapters[p.name]?.receiptExecuted === true);
    if (complete) break;
    const anySeen =
      effects.settlementFinalized === true ||
      protocols.some((p) => effects.adapters[p.name]?.receiptExecuted === true) ||
      effects.operationStillDelegated === false;
    if (anySeen && firstEffectAt === null) firstEffectAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, OBSERVATION_INTERVAL_MS));
    effects = await readEffects();
    process.stdout.write(".");
  }
  console.log("");

  const observationMs = Date.now() - scheduledAt;

  // --------------------------------------------------------- classification

  const applied = protocols.filter(
    (p) =>
      effects.adapters[p.name]?.receiptExecuted === true &&
      effects.adapters[p.name]?.marketPaused === true,
  ).length;
  const absent = protocols.filter(
    (p) =>
      effects.adapters[p.name]?.receiptExecuted === false &&
      effects.adapters[p.name]?.marketPaused === false,
  ).length;
  const checkpointCommitted = effects.operationStillDelegated === false;

  let classification: string;
  if (effects.settlementFinalized === true && applied === protocols.length) {
    classification = "ALL_ACTIONS_APPLIED";
  } else if (
    checkpointCommitted &&
    effects.settlementFinalized === false &&
    absent === protocols.length
  ) {
    classification = "COMMIT_WITHOUT_ACTIONS";
  } else if (applied > 0 || effects.settlementFinalized === true) {
    classification = "PARTIAL_OBSERVATION";
  } else {
    classification = "UNKNOWN";
  }

  console.log(`\n  adapters applied      ${applied}/${protocols.length}`);
  console.log(`  adapters absent       ${absent}/${protocols.length}`);
  console.log(`  settlement finalized  ${effects.settlementFinalized}`);
  console.log(`  checkpoint committed  ${checkpointCommitted}`);
  console.log(`  CLASSIFICATION        ${classification}`);

  // ------------------------------------------------------------- artifact

  const artifact = {
    captured_at: capturedAt,
    run: runLabel,
    deliberate_failure: FAIL_ONE,
    network: NETWORK_LABEL,
    cluster_genesis_hash: genesisHash,
    endpoints: {
      base: BASE_RPC,
      router: ROUTER,
      ephemeral_rollup: resolution.endpoint,
    },
    programs: {
      core: CORE_PROGRAM_ID.toBase58(),
      adapter: ADAPTER_PROGRAM_ID.toBase58(),
      mock_protocol: MOCK_PROTOCOL_PROGRAM_ID.toBase58(),
    },
    operation_id: Buffer.from(operationId).toString("hex"),
    covenant: covenant.toBase58(),
    certificate: certificateAddress(operationId).toBase58(),
    operation_account: operation.toBase58(),
    protocols: protocols.map((p) => ({
      name: p.name,
      authority: p.authority.publicKey.toBase58(),
      market: p.market.toBase58(),
      capability: p.capability.toBase58(),
      adapter_signer: p.adapterSigner.toBase58(),
      adapter_receipt: p.receipt.toBase58(),
    })),
    routing: {
      resolved_endpoint: resolution.endpoint,
      resolution_source: resolution.source,
      get_delegation_status_fields: resolution.evidence.delegationStatusFields,
      get_delegation_status_raw: resolution.evidence.delegationStatus,
      validator_identity: resolution.evidence.validatorIdentity,
      advertised_routes: resolution.evidence.routes,
      note: resolution.evidence.note,
    },
    scheduling: {
      er_signature: erSignature,
      er_compute_units: erComputeUnits,
      serialized_transaction_bytes: serializedSize,
      account_count: cohortInstruction.keys.length,
      declared_adapter_compute_units: ADAPTER_ACTION_CU,
      declared_settlement_compute_units: SETTLEMENT_ACTION_CU,
      declared_total_action_compute_units:
        ADAPTER_ACTION_CU * protocols.length + SETTLEMENT_ACTION_CU,
      meaning:
        "INTENT_ACCEPTED. The ER accepted the intent bundle. This says nothing about whether any base-layer action ran.",
    },
    observation: {
      window_ms: OBSERVATION_WINDOW_MS,
      elapsed_ms: observationMs,
      first_effect_after_ms: firstEffectAt === null ? null : firstEffectAt - scheduledAt,
      effects,
      adapters_applied: applied,
      adapters_absent: absent,
      checkpoint_committed: checkpointCommitted,
    },
    classification,
    steps,
    limitations: [
      "Effects are read from base-layer account state. Nothing is inferred from the ER scheduling signature.",
      "An action whose account could not be read is recorded as null, never as absent.",
      "Whether all four BaseActions shared one TransactionStrategy is not directly observable from account state; the classification records what landed, not how it was grouped.",
    ],
  };

  const outputDir = process.env.VINCT_ARTIFACT_DIR
    ? join(REPO_ROOT, process.env.VINCT_ARTIFACT_DIR)
    : ARTIFACT_DIR;
  mkdirSync(outputDir, { recursive: true });
  const stamp = capturedAt.replace(/[:.]/g, "-");
  writeFileSync(
    join(outputDir, `phase3-seam-${runLabel}-${stamp}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  writeFileSync(
    join(outputDir, `phase3-seam-${runLabel}-latest.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  console.log(`\nwrote ${join(outputDir, `phase3-seam-${runLabel}-latest.json`)}`);
  void execFileSync;
}

await main();

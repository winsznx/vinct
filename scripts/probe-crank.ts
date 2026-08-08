/**
 * Does the pinned ephemeral validator accept a scheduled task, and on what terms?
 *
 * Phase 0 left this open: the SDK exposes `ScheduleCrankCpi`, the crank example uses a raw
 * `MagicBlockInstruction::ScheduleTask` bincode encoding, and nothing in the repository has
 * ever sent either to a running validator. Everything Phase 6 does rests on the answer, so it
 * gets asked directly before any of it is built.
 *
 * Three questions, in order:
 *
 *   1. Is the `ScheduleTask` variant recognised at all by this validator?
 *   2. Can it be submitted directly, or only through a CPI from the program owning the
 *      account the task will touch?
 *   3. What does the task context account slot actually want?
 *
 * A refusal is a result. The artifact records what was sent and what came back, and nothing
 * here concludes anything the validator did not say.
 *
 *   bash scripts/bootstrap-local.sh start
 *   pnpm exec tsx scripts/probe-crank.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import { CORE_PROGRAM_ID } from "../packages/client/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "local-stack");

const BASE_RPC = process.env.VINCT_BASE_RPC ?? "http://127.0.0.1:8899";
const ER_RPC = process.env.VINCT_ER_RPC ?? "http://127.0.0.1:7799";

/**
 * `MagicBlockInstruction::ScheduleTask` is the seventh variant of the enum in
 * `magicblock-magic-program-api 0.10.1`, counting from zero: ModifyAccounts, ScheduleCommit,
 * ScheduleCommitAndUndelegate, AcceptScheduleCommits, ScheduledCommitSent, ScheduleBaseIntent,
 * ScheduleTask. Bincode writes an enum discriminant as a little-endian u32.
 */
const SCHEDULE_TASK_VARIANT = 6;
const CANCEL_TASK_VARIANT = 7;

/** How long to watch for a scheduled iteration before recording that none arrived. */
const ITERATION_WATCH_MS = 20_000;

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function i64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value);
  return out;
}

/** Bincode writes a sequence length as a little-endian u64. */
function seqLen(count: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(count));
  return out;
}

/** solana_program::instruction::Instruction, in bincode's default fixed-int encoding. */
function encodeInstruction(instruction: TransactionInstruction): Buffer {
  const metas = instruction.keys.map((key) =>
    Buffer.concat([
      key.pubkey.toBuffer(),
      Buffer.from([key.isSigner ? 1 : 0]),
      Buffer.from([key.isWritable ? 1 : 0]),
    ]),
  );
  return Buffer.concat([
    instruction.programId.toBuffer(),
    seqLen(metas.length),
    ...metas,
    seqLen(instruction.data.length),
    instruction.data,
  ]);
}

function encodeScheduleTask(args: {
  taskId: bigint;
  executionIntervalMillis: bigint;
  iterations: bigint;
  instructions: TransactionInstruction[];
}): Buffer {
  return Buffer.concat([
    u32(SCHEDULE_TASK_VARIANT),
    i64(args.taskId),
    i64(args.executionIntervalMillis),
    i64(args.iterations),
    seqLen(args.instructions.length),
    ...args.instructions.map(encodeInstruction),
  ]);
}

function encodeCancelTask(taskId: bigint): Buffer {
  return Buffer.concat([u32(CANCEL_TASK_VARIANT), i64(taskId)]);
}

interface Attempt {
  attempt: string;
  question: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  dataLength: number;
  accepted: boolean;
  signature?: string;
  error?: string;
  logs?: string[];
}

const attempts: Attempt[] = [];

async function tryOn(
  er: Connection,
  payer: Keypair,
  label: string,
  question: string,
  instruction: TransactionInstruction,
): Promise<boolean> {
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = payer.publicKey;
  const record: Attempt = {
    attempt: label,
    question,
    accounts: instruction.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    dataLength: instruction.data.length,
    accepted: false,
  };
  try {
    record.signature = await sendAndConfirmTransaction(er, transaction, [payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });
    record.accepted = true;
    const parsed = await er.getTransaction(record.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    record.logs = parsed?.meta?.logMessages ?? [];
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    const logs = (error as { transactionLogs?: string[] }).transactionLogs;
    if (logs) record.logs = logs;
  }
  attempts.push(record);
  console.log(`  ${label}: ${record.accepted ? "ACCEPTED" : "REFUSED"}`);
  if (!record.accepted && record.error) {
    console.log(`    ${record.error.split("\n")[0]}`);
  }
  for (const line of (record.logs ?? []).slice(0, 8)) console.log(`    | ${line}`);
  return record.accepted;
}

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString();
  const base = new Connection(BASE_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");

  const payer = Keypair.generate();
  await base.confirmTransaction(
    await base.requestAirdrop(payer.publicKey, 20_000_000_000),
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

  // No VINCT account is involved. The question here is only whether this validator knows the
  // instruction, and an account that fails a program's own checks would answer a different
  // question. The payer stands in for the task context slot.
  const taskContext = payer.publicKey;

  console.log("VINCT crank probe");
  console.log(`  base ${BASE_RPC}   er ${ER_RPC}`);
  console.log(`  validator ${validator.toBase58()}`);
  console.log("");

  // A harmless inner instruction. `build_info` reads nothing and writes nothing, so if the
  // scheduler ever runs it the only evidence is a log line, which is what a probe wants.
  const inner = new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [],
    // sha256("global:build_info")[0..8]
    data: Buffer.from("ee7922f6de73e9b5", "hex"),
  });

  const taskId = 4242n;

  console.log("Direct submission, payer plus the delegated account");
  await tryOn(
    er,
    payer,
    "schedule-direct",
    "Is ScheduleTask recognised when submitted directly rather than through a CPI?",
    new TransactionInstruction({
      programId: MAGIC_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: taskContext, isSigner: false, isWritable: true },
      ],
      data: encodeScheduleTask({
        taskId,
        executionIntervalMillis: 1_000n,
        iterations: 2n,
        instructions: [inner],
      }),
    }),
  );

  console.log("\nDirect submission, payer only");
  await tryOn(
    er,
    payer,
    "schedule-payer-only",
    "Does the task context slot need to be filled at all?",
    new TransactionInstruction({
      programId: MAGIC_PROGRAM_ID,
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      data: encodeScheduleTask({
        taskId: taskId + 1n,
        executionIntervalMillis: 1_000n,
        iterations: 2n,
        instructions: [inner],
      }),
    }),
  );

  console.log("\nCancel");
  await tryOn(
    er,
    payer,
    "cancel-direct",
    "Is CancelTask recognised, and does it refuse an id nobody scheduled?",
    new TransactionInstruction({
      programId: MAGIC_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: taskContext, isSigner: false, isWritable: true },
      ],
      data: encodeCancelTask(taskId),
    }),
  );

  // The question the log line cannot answer. "Scheduled task request with ID: 4243" says a
  // request was stashed. Whether the scheduler then registered it and ran the instruction is a
  // separate observation, and the whole PRD crank state machine exists because those two can
  // differ. The only honest signal is the inner instruction's own footprint on the rollup.
  console.log("\nWatching for an actual iteration");
  const before = await er.getSignaturesForAddress(CORE_PROGRAM_ID, { limit: 1 });
  const marker = before[0]?.signature ?? null;
  const deadline = Date.now() + ITERATION_WATCH_MS;
  let executions: string[] = [];
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const seen = await er.getSignaturesForAddress(CORE_PROGRAM_ID, { limit: 20 });
    const fresh = marker
      ? seen.slice(0, seen.findIndex((entry) => entry.signature === marker) + 1 || seen.length)
      : seen;
    executions = fresh.map((entry) => entry.signature).filter((sig) => sig !== marker);
    if (executions.length >= 2) break;
  }
  const iterationObserved = executions.length > 0;
  console.log(
    `  transactions touching the core program on the rollup since scheduling: ${executions.length}`,
  );
  console.log(`  ITERATION_OBSERVED: ${iterationObserved}`);
  if (!iterationObserved) {
    console.log(
      "  The request was accepted and no iteration followed within the watch window. That is a",
    );
    console.log(
      "  finding about this validator, not a failure of the probe, and it is what the artifact",
    );
    console.log("  records.");
  }

  const anyAccepted = attempts.some((a) => a.accepted);
  console.log(`\nScheduleTask reachable on this validator: ${anyAccepted}`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    join(ARTIFACT_DIR, "crank-probe.json"),
    `${JSON.stringify(
      {
        captured_at: capturedAt,
        question:
          "Does the pinned ephemeral validator accept MagicBlockInstruction::ScheduleTask, and on what terms?",
        endpoints: { base: BASE_RPC, er: ER_RPC },
        validator_identity: validator.toBase58(),
        encoding:
          "bincode, default fixed-int: enum discriminant as u32 LE, sequence length as u64 LE, Pubkey as 32 raw bytes, bool as one byte",
        schedule_task_variant_index: SCHEDULE_TASK_VARIANT,
        source:
          "magicblock-magic-program-api 0.10.1, src/instruction.rs; variant index counted from the enum declaration order",
        any_accepted: anyAccepted,
        iteration_observed: iterationObserved,
        iteration_signatures: executions,
        iteration_watch_ms: ITERATION_WATCH_MS,
        attempts,
        note: "A refusal here is evidence about the validator, not about the encoding. Both are recorded so a later run can tell which changed.",
      },
      null,
      2,
    )}\n`,
  );
  console.log("Wrote artifacts/local-stack/crank-probe.json");
}

await main();

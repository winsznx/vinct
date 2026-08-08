/**
 * Does a PER permission gate reading, or gate touching?
 *
 * VINCT's sealed-quorum property turns on the answer. If a wallet must be inside an
 * account's permission to send a transaction that mutates it, then every member has to be
 * inside the aggregate's permission, and every member can therefore read the running tally
 * and each other's ballots. If a transaction can mutate an account its sender cannot read,
 * the state splits cleanly: one ballot per member, private to that member, and an aggregate
 * that nobody can read at all.
 *
 * The official sealed-auction example does not settle it. Its auctioneer is a member of
 * every bid permission and is the one who calls `end_auction`, so no caller there ever
 * touches an account it cannot read.
 *
 * Run against the TEE-backed rollup, resolved from live routing:
 *
 *   pnpm exec tsx scripts/per-visibility-experiment.ts
 *
 * Writes artifacts/devnet/per-visibility-experiment-latest.json.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type AccountMeta,
} from "@solana/web3.js";

import { authenticate } from "../packages/client/src/per-auth.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "devnet");
const IDL = JSON.parse(
  readFileSync(join(REPO_ROOT, "target", "idl", "per_visibility_probe.json"), "utf8"),
) as { address: string; instructions: { name: string; discriminator: number[] }[] };

const PROBE_ID = new PublicKey(IDL.address);
const BASE_RPC = process.env.VINCT_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
const ROUTER = process.env.VINCT_ROUTER ?? "https://devnet-router.magicblock.app/";
const KEYPAIR = process.env.VINCT_KEYPAIR ?? ".toolchain/keys/devnet-deployer.json";
const ROUND = BigInt(process.env.VINCT_PROBE_ROUND ?? "1");

const AGGREGATE_SEED = Buffer.from("probe-aggregate");
const BALLOT_SEED = Buffer.from("probe-ballot");

function disc(name: string): Buffer {
  const found = IDL.instructions.find((i) => i.name === name);
  if (!found) throw new Error(`${name} is not in the probe IDL`);
  return Buffer.from(found.discriminator);
}

function u64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function aggregateAddress(round: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([AGGREGATE_SEED, u64(round)], PROBE_ID)[0];
}

function ballotAddress(round: bigint, member: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [BALLOT_SEED, u64(round), member.toBuffer()],
    PROBE_ID,
  )[0];
}

const log: string[] = [];
function say(line: string): void {
  log.push(line);
  console.log(line);
}

function derived(seed: string): Keypair {
  return Keypair.fromSeed(new Uint8Array(createHash("sha256").update(seed).digest()).slice(0, 32));
}

async function send(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  label: string,
  skipPreflight = false,
): Promise<string> {
  const transaction = new Transaction().add(...instructions);
  const first = signers[0];
  if (!first) throw new Error("need a signer");
  transaction.feePayer = first.publicKey;
  const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
    skipPreflight,
    commitment: "confirmed",
  });
  say(`  ${label} ${signature}`);
  return signature;
}

async function tolerate<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("already in use") || message.includes("custom program error: 0x0")) {
      say(`  ${label} (already existed)`);
      return null;
    }
    throw cause;
  }
}

/** What a given session can see of a given account. */
interface ReadResult {
  readable: boolean;
  byteLength: number | null;
  detail: string;
}

async function readAs(connection: Connection, address: PublicKey): Promise<ReadResult> {
  try {
    const account = await connection.getAccountInfo(address, "confirmed");
    if (!account) {
      return { readable: false, byteLength: null, detail: "the rollup returned no account" };
    }
    return {
      readable: true,
      byteLength: account.data.length,
      detail: `${account.data.length} bytes`,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { readable: false, byteLength: null, detail: message.slice(0, 160) };
  }
}

function permissionKeys(account: PublicKey): AccountMeta[] {
  return [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: permissionPdaFromAccount(account), isSigner: false, isWritable: true },
    { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
    { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

function delegateKeys(payer: PublicKey, account: PublicKey, validator: PublicKey): AccountMeta[] {
  return [
    { pubkey: payer, isSigner: true, isWritable: true },
    {
      pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(account, PROBE_ID),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: delegationRecordPdaFromDelegatedAccount(account), isSigner: false, isWritable: true },
    {
      pubkey: delegationMetadataPdaFromDelegatedAccount(account),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: validator, isSigner: false, isWritable: false },
    { pubkey: PROBE_ID, isSigner: false, isWritable: false },
    { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString();
  const base = new Connection(BASE_RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(REPO_ROOT, KEYPAIR), "utf8")) as number[]),
  );
  const memberA = derived(`per-probe:${ROUND}:A`);
  const memberB = derived(`per-probe:${ROUND}:B`);

  const aggregate = aggregateAddress(ROUND);
  const ballotA = ballotAddress(ROUND, memberA.publicKey);
  const ballotB = ballotAddress(ROUND, memberB.publicKey);

  say(`PER visibility experiment, round ${ROUND}`);
  say(`  probe program ${PROBE_ID.toBase58()}`);
  say(`  aggregate     ${aggregate.toBase58()}`);
  say(`  ballot A      ${ballotA.toBase58()}  member ${memberA.publicKey.toBase58()}`);
  say(`  ballot B      ${ballotB.toBase58()}  member ${memberB.publicKey.toBase58()}`);
  say("");

  // ------------------------------------------------------- attested rollup

  say("Resolving an attested rollup from live routing");
  const routes = (await (
    await fetch(ROUTER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRoutes" }),
    })
  ).json()) as { result?: { identity: string; fqdn: string }[] };

  let endpoint: string | null = null;
  let identity: string | null = null;
  for (const route of routes.result ?? []) {
    try {
      await verifyTeeRpcIntegrity(route.fqdn.replace(/\/$/, ""));
      endpoint = route.fqdn;
      identity = route.identity;
      say(`  ${route.fqdn} TDX quote verified`);
      break;
    } catch {
      say(`  ${route.fqdn} no quote`);
    }
  }
  if (!endpoint || !identity) throw new Error("no attested rollup available");
  const validator = new PublicKey(identity);

  // ------------------------------------------------------------- funding

  const funding: TransactionInstruction[] = [];
  for (const member of [memberA, memberB]) {
    if ((await base.getBalance(member.publicKey)) < 3_000_000) {
      funding.push(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: member.publicKey,
          lamports: 6_000_000,
        }),
      );
    }
  }
  if (funding.length > 0) await send(base, funding, [payer], "fund members");

  // ------------------------------------------------- base setup and delegation

  say("\nCreating and delegating the three accounts on base");
  await tolerate("init aggregate", () =>
    send(
      base,
      [
        new TransactionInstruction({
          programId: PROBE_ID,
          keys: [
            { pubkey: aggregate, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("init_aggregate"), u64(ROUND)]),
        }),
      ],
      [payer],
      "init aggregate",
    ),
  );

  for (const [name, member, ballot] of [
    ["A", memberA, ballotA],
    ["B", memberB, ballotB],
  ] as const) {
    await tolerate(`init ballot ${name}`, () =>
      send(
        base,
        [
          new TransactionInstruction({
            programId: PROBE_ID,
            keys: [
              { pubkey: ballot, isSigner: false, isWritable: true },
              { pubkey: payer.publicKey, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([disc("init_ballot"), u64(ROUND), member.publicKey.toBuffer()]),
          }),
        ],
        [payer],
        `init ballot ${name}`,
      ),
    );
  }

  const isDelegated = async (account: PublicKey): Promise<boolean> =>
    (await base.getAccountInfo(account))?.owner.toBase58() === DELEGATION_PROGRAM_ID.toBase58();

  if (!(await isDelegated(aggregate))) {
    await send(
      base,
      [
        new TransactionInstruction({
          programId: PROBE_ID,
          keys: delegateKeys(payer.publicKey, aggregate, validator),
          data: Buffer.concat([disc("delegate_aggregate"), u64(ROUND)]),
        }),
      ],
      [payer],
      "delegate aggregate",
    );
  }
  for (const [name, member, ballot] of [
    ["A", memberA, ballotA],
    ["B", memberB, ballotB],
  ] as const) {
    if (!(await isDelegated(ballot))) {
      await send(
        base,
        [
          new TransactionInstruction({
            programId: PROBE_ID,
            keys: delegateKeys(payer.publicKey, ballot, validator),
            data: Buffer.concat([disc("delegate_ballot"), u64(ROUND), member.publicKey.toBuffer()]),
          }),
        ],
        [payer],
        `delegate ballot ${name}`,
      );
    }
  }

  // ---------------------------------------------------------- sessions

  say("\nAuthenticating each principal separately");
  const sessionPayer = await authenticate(endpoint, payer);
  const sessionA = await authenticate(endpoint, memberA);
  const sessionB = await authenticate(endpoint, memberB);
  say(`  three sessions on ${sessionPayer.redactedUrl}`);

  // ------------------------------------------------------- permissions

  say("\nCreating permissions");
  await tolerate("aggregate permission", () =>
    send(
      sessionPayer.connection,
      [
        new TransactionInstruction({
          programId: PROBE_ID,
          keys: permissionKeys(aggregate),
          data: disc("create_unreadable_aggregate_permission"),
        }),
      ],
      [payer],
      "aggregate permission (member: the aggregate PDA, a key nobody holds)",
      true,
    ),
  );
  for (const [name, ballot] of [
    ["A", ballotA],
    ["B", ballotB],
  ] as const) {
    await tolerate(`ballot ${name} permission`, () =>
      send(
        sessionPayer.connection,
        [
          new TransactionInstruction({
            programId: PROBE_ID,
            keys: permissionKeys(ballot),
            data: disc("create_ballot_permission"),
          }),
        ],
        [payer],
        `ballot ${name} permission (member: ${name} alone)`,
        true,
      ),
    );
  }

  // ------------------------------------------------------ the experiment

  say("\nCasting: each member writes their own ballot and the aggregate");
  const castResults: Record<string, string> = {};
  for (const [name, member, session] of [
    ["A", memberA, sessionA],
    ["B", memberB, sessionB],
  ] as const) {
    const approve = name === "A";
    try {
      const signature = await send(
        session.connection,
        [
          new TransactionInstruction({
            programId: PROBE_ID,
            keys: [
              { pubkey: member.publicKey, isSigner: true, isWritable: false },
              { pubkey: ballotAddress(ROUND, member.publicKey), isSigner: false, isWritable: true },
              { pubkey: aggregate, isSigner: false, isWritable: true },
            ],
            data: Buffer.concat([disc("cast"), u64(ROUND), Buffer.from([approve ? 1 : 0])]),
          }),
        ],
        [member],
        `${name} casts ${approve ? "approve" : "reject"}`,
        true,
      );
      castResults[name] = signature;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      castResults[name] = `FAILED ${message.slice(0, 200)}`;
      say(`  ${name} cast FAILED: ${message.slice(0, 200)}`);
    }
  }

  say("\nReading, one principal at a time");
  const reads = {
    aOwnBallot: await readAs(sessionA.connection, ballotA),
    aOtherBallot: await readAs(sessionA.connection, ballotB),
    aAggregate: await readAs(sessionA.connection, aggregate),
    bOwnBallot: await readAs(sessionB.connection, ballotB),
    bOtherBallot: await readAs(sessionB.connection, ballotA),
    bAggregate: await readAs(sessionB.connection, aggregate),
    payerAggregate: await readAs(sessionPayer.connection, aggregate),
    payerBallotA: await readAs(sessionPayer.connection, ballotA),
    anonymousAggregate: await readAs(new Connection(endpoint, "confirmed"), aggregate),
    anonymousBallotA: await readAs(new Connection(endpoint, "confirmed"), ballotA),
  };
  for (const [label, result] of Object.entries(reads)) {
    say(`  ${label.padEnd(20)} ${result.readable ? "READABLE" : "refused"}  ${result.detail}`);
  }

  // ------------------------------------------- did the program get it right

  say("\nOpening the aggregate to check the program's arithmetic");
  let observed: { approvals: number; rejections: number } | null = null;
  try {
    await send(
      sessionPayer.connection,
      [
        new TransactionInstruction({
          programId: PROBE_ID,
          keys: permissionKeys(aggregate),
          data: disc("close_aggregate_permission"),
        }),
      ],
      [payer],
      "close aggregate permission",
      true,
    );
    const account = await new Connection(endpoint, "confirmed").getAccountInfo(aggregate);
    if (account) {
      const body = account.data.subarray(8);
      observed = { approvals: body[8] ?? 0, rejections: body[9] ?? 0 };
      say(
        `  aggregate now readable: ${observed.approvals} approvals, ${observed.rejections} rejections`,
      );
    }
  } catch (cause) {
    say(`  could not open the aggregate: ${(cause as Error).message.slice(0, 160)}`);
  }

  // ---------------------------------------------------------- conclusion

  const bothCast = !castResults.A?.startsWith("FAILED") && !castResults.B?.startsWith("FAILED");
  const peersBlind = !reads.aOtherBallot.readable && !reads.bOtherBallot.readable;
  const aggregateHidden = !reads.aAggregate.readable && !reads.bAggregate.readable;
  const ownVisible = reads.aOwnBallot.readable && reads.bOwnBallot.readable;
  const arithmeticCorrect = observed?.approvals === 1 && observed?.rejections === 1;

  const outcome =
    bothCast && peersBlind && aggregateHidden && ownVisible && arithmeticCorrect
      ? "EXECUTION_IS_NOT_QUERY_AUTHORIZATION"
      : bothCast
        ? "PARTIAL"
        : "EXECUTION_REQUIRES_PERMISSION_MEMBERSHIP";

  say(`\nOutcome: ${outcome}`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifact = {
    captured_at: capturedAt,
    question:
      "On a private ephemeral rollup, does an account's permission gate reading it, or gate any transaction that touches it?",
    why_it_matters:
      "If membership is required to mutate, every voting member must be inside the aggregate's permission and can therefore read the live tally and every peer's ballot. If not, per-member ballot accounts and an unreadable aggregate become possible.",
    endpoint,
    validator: identity,
    probe_program: PROBE_ID.toBase58(),
    round: ROUND.toString(),
    accounts: {
      aggregate: aggregate.toBase58(),
      aggregate_permission_members: [
        "the aggregate PDA itself, which is off-curve and unauthenticatable",
      ],
      ballot_a: ballotA.toBase58(),
      ballot_b: ballotB.toBase58(),
      member_a: memberA.publicKey.toBase58(),
      member_b: memberB.publicKey.toBase58(),
    },
    casts: castResults,
    reads,
    aggregate_after_opening: observed,
    findings: {
      both_members_could_cast: bothCast,
      neither_member_could_read_the_other_ballot: peersBlind,
      neither_member_could_read_the_aggregate: aggregateHidden,
      each_member_could_read_their_own_ballot: ownVisible,
      program_arithmetic_correct: arithmeticCorrect,
    },
    outcome,
    transcript: log,
  };
  const stamp = capturedAt.replace(/[:.]/g, "-");
  const body = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(join(ARTIFACT_DIR, `per-visibility-experiment-${stamp}.json`), body);
  writeFileSync(join(ARTIFACT_DIR, "per-visibility-experiment-latest.json"), body);
  say("\nWrote artifacts/devnet/per-visibility-experiment-latest.json");
}

await main();

/**
 * The sealed-quorum lifecycle against the local MagicBlock stack.
 *
 * What this proves and what it does not, stated up front because the distinction is the
 * whole reason the script exists separately from `phase4-per.ts`.
 *
 * It proves the mechanics: five accounts delegated, three permissions created through CPI,
 * a claim and two ballots written, certification counting every ballot passed at once, a
 * per-account scrub, and one intent committing and undelegating all five. If any of that is
 * wrong, it is wrong here, and finding out costs a local restart rather than a Devnet
 * deploy.
 *
 * It also exercises the read matrix, because the local stack runs the same query-filtering
 * service with the same challenge-sign-login flow as the hosted endpoint.
 *
 * It proves nothing about a TEE. There is no enclave here and no attestation, so a passing
 * run says the permission model behaves as expected on the reference implementation, not
 * that a confidential runtime is holding the line. That is what the Devnet run is for.
 *
 *   bash scripts/bootstrap-local.sh start
 *   pnpm exec tsx scripts/phase4-local-lifecycle.ts
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
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  CORE_PROGRAM_ID,
  Decision,
  IncidentStatus,
  attestationAddress,
  authenticate,
  certifyIncident,
  claimAddress,
  closeAttestationPermission,
  closeClaimPermission,
  createAttestationPermission,
  createClaimPermission,
  decodeIncidentCore,
  delegateAttestation,
  delegateClaim,
  delegateIncident,
  incidentAddress,
  initializeAttestation,
  initializeClaim,
  initializeIncident,
  interactionOnly,
  openIncident,
  releaseIncident,
  scrubAttestation,
  scrubClaim,
  submitPrivateClaim,
  submitSealedAttestation,
} from "../packages/client/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "local-stack");

const BASE_RPC = process.env.VINCT_BASE_RPC ?? "http://127.0.0.1:8899";
/** Writes go to the ephemeral validator. */
const ER_RPC = process.env.VINCT_ER_RPC ?? "http://127.0.0.1:7799";
/** Authenticated reads go through the query-filtering service, which is what enforces them. */
const QFS_RPC = process.env.VINCT_QFS_RPC ?? "http://127.0.0.1:6699";
const INCIDENT_ID = BigInt(process.env.VINCT_INCIDENT_ID ?? "1");

const CANARY_CLAIM = "VINCT-LOCAL-CANARY-CLAIM-4f2a9c1e";
const CANARY_NOTES = "VINCT-LOCAL-CANARY-NOTES-7b3d5e08";
const ATTESTING_MEMBERS = 2;

const log: string[] = [];
function say(line: string): void {
  log.push(line);
  console.log(line);
}

function sha256(input: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

function derived(seed: string): Keypair {
  return Keypair.fromSeed(sha256(seed).slice(0, 32));
}

async function send(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const transaction = new Transaction().add(...instructions);
  const first = signers[0];
  if (!first) throw new Error("need a signer");
  transaction.feePayer = first.publicKey;
  const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
    skipPreflight: true,
    commitment: "confirmed",
  });
  say(`  ${label} ${signature.slice(0, 16)}…`);
  return signature;
}

async function tolerate(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("already in use") || message.includes("custom program error: 0x0")) {
      say(`  ${label} (already existed)`);
      return;
    }
    throw cause;
  }
}

interface ReadResult {
  readable: boolean;
  byteLength: number | null;
}

async function readAs(connection: Connection, address: PublicKey): Promise<ReadResult> {
  try {
    const account = await connection.getAccountInfo(address, "confirmed");
    return account
      ? { readable: true, byteLength: account.data.length }
      : { readable: false, byteLength: null };
  } catch {
    return { readable: false, byteLength: null };
  }
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

  const covenant = derived(`local:${INCIDENT_ID}:covenant`).publicKey;
  const core = incidentAddress(covenant, INCIDENT_ID);
  const claim = claimAddress(core);
  const names = ["alpha", "beta", "gamma"] as const;
  const members = names.map((name) => derived(`local:${INCIDENT_ID}:member:${name}`));
  const memberKeys = members.map((m) => m.publicKey);
  const outsider = derived(`local:${INCIDENT_ID}:outsider`);

  say("VINCT Phase 4 — sealed-quorum lifecycle on the local stack");
  say(`  base ${BASE_RPC}   er ${ER_RPC}   qfs ${QFS_RPC}`);
  say(`  validator ${validator.toBase58()}`);
  say("  no TEE here: this proves the mechanics and the permission model, not confidentiality");
  say("");

  for (const keypair of [...members, outsider]) {
    await base.confirmTransaction(
      await base.requestAirdrop(keypair.publicKey, 2_000_000_000),
      "confirmed",
    );
  }

  say("Creating the incident's accounts on base");
  await tolerate("core", () =>
    send(base, [initializeIncident(payer.publicKey, covenant, INCIDENT_ID)], [payer], "core"),
  );
  await tolerate("claim", () =>
    send(base, [initializeClaim(core, payer.publicKey)], [payer], "claim"),
  );
  for (const [index, member] of members.entries()) {
    await tolerate(`ballot ${names[index]}`, () =>
      send(
        base,
        [initializeAttestation(core, payer.publicKey, member.publicKey)],
        [payer],
        `ballot ${names[index]}`,
      ),
    );
  }

  const delegationFor = (account: PublicKey) => ({
    buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(account, CORE_PROGRAM_ID),
    record: delegationRecordPdaFromDelegatedAccount(account),
    metadata: delegationMetadataPdaFromDelegatedAccount(account),
    delegationProgram: DELEGATION_PROGRAM_ID,
  });

  say("\nDelegating all five accounts");
  await send(
    base,
    [delegateIncident(payer.publicKey, covenant, INCIDENT_ID, validator, delegationFor(core))],
    [payer],
    "delegate core",
  );
  await send(
    base,
    [delegateClaim(payer.publicKey, core, validator, delegationFor(claim))],
    [payer],
    "delegate claim",
  );
  for (const [index, member] of members.entries()) {
    const attestation = attestationAddress(core, member.publicKey);
    await send(
      base,
      [
        delegateAttestation(
          payer.publicKey,
          core,
          member.publicKey,
          validator,
          delegationFor(attestation),
        ),
      ],
      [payer],
      `delegate ballot ${names[index]}`,
    );
  }

  say("\nCreating permissions");
  await send(
    er,
    [
      createClaimPermission(
        core,
        payer.publicKey,
        [payer, ...members].map((k) => interactionOnly(k.publicKey)),
      ),
    ],
    [payer],
    "claim permission",
  );
  for (const [index, member] of members.entries()) {
    await send(
      er,
      [createAttestationPermission(core, member.publicKey)],
      [payer],
      `ballot ${names[index]} permission`,
    );
  }

  say("\nRunning the incident");
  await send(
    er,
    [
      openIncident(payer.publicKey, {
        covenant,
        incidentId: INCIDENT_ID,
        circleEpoch: 1n,
        policyId: sha256("local:policy"),
        memberSetHash: sha256("local:members"),
        clusterGenesisHash: new PublicKey(await base.getGenesisHash()).toBytes(),
        requiredApprovals: 2,
        maximumRejections: 1,
        responseWindowSlots: 200_000n,
        memberCount: members.length,
        claimDigest: sha256(CANARY_CLAIM),
      }),
    ],
    [payer],
    "open",
  );
  await send(
    er,
    [
      submitPrivateClaim(core, payer.publicKey, {
        claim: Buffer.from(CANARY_CLAIM, "utf8"),
        observationStart: 1n,
        observationEnd: 2n,
        notes: Buffer.from(CANARY_NOTES, "utf8"),
      }),
    ],
    [payer],
    "claim",
  );
  for (const [index, member] of members.slice(0, ATTESTING_MEMBERS).entries()) {
    await send(
      er,
      [submitSealedAttestation(core, member.publicKey, Decision.Approve, BigInt(index) + 1n)],
      [member],
      `${names[index]} attests`,
    );
  }
  say(`  ${names[2]} stays silent`);

  say("\nThe read matrix, through each principal's own authenticated session");
  const sessionFor = async (keypair: Keypair): Promise<Connection> =>
    (await authenticate(QFS_RPC, keypair)).connection;
  const alpha = await sessionFor(members[0]!);
  const beta = await sessionFor(members[1]!);
  const opener = await sessionFor(payer);
  const stranger = await sessionFor(outsider);
  const ballotOf = (index: number): PublicKey =>
    attestationAddress(core, members[index]!.publicKey);

  const matrix = {
    alphaOwnBallot: await readAs(alpha, ballotOf(0)),
    alphaReadsBetaBallot: await readAs(alpha, ballotOf(1)),
    betaOwnBallot: await readAs(beta, ballotOf(1)),
    betaReadsAlphaBallot: await readAs(beta, ballotOf(0)),
    openerReadsAlphaBallot: await readAs(opener, ballotOf(0)),
    outsiderReadsAlphaBallot: await readAs(stranger, ballotOf(0)),
    memberReadsClaim: await readAs(alpha, claim),
    outsiderReadsClaim: await readAs(stranger, claim),
    anyoneReadsCore: await readAs(stranger, core),
    anonymousReadsClaim: await readAs(new Connection(QFS_RPC, "confirmed"), claim),
    anonymousReadsAlphaBallot: await readAs(new Connection(QFS_RPC, "confirmed"), ballotOf(0)),
  };
  for (const [label, result] of Object.entries(matrix)) {
    say(
      `  ${label.padEnd(26)} ${result.readable ? `READABLE (${result.byteLength} bytes)` : "refused"}`,
    );
  }

  say("\nCertifying, scrubbing, and releasing");
  await send(er, [certifyIncident(core, memberKeys)], [payer], "certify");
  await send(er, [scrubClaim(core)], [payer], "scrub claim");
  for (const [index, member] of members.entries()) {
    await send(er, [scrubAttestation(core, member.publicKey)], [payer], `scrub ${names[index]}`);
  }
  await send(er, [closeClaimPermission(core)], [payer], "close claim permission");
  for (const [index, member] of members.entries()) {
    await send(
      er,
      [closeAttestationPermission(core, member.publicKey)],
      [payer],
      `close ${names[index]} permission`,
    );
  }
  await send(
    er,
    [releaseIncident(payer.publicKey, covenant, INCIDENT_ID, memberKeys)],
    [payer],
    "release",
  );

  say("\nObserving base propagation");
  const deadline = Date.now() + 60_000;
  let owner: string | null = null;
  let coreData: Buffer | null = null;
  while (Date.now() < deadline) {
    const account = await base.getAccountInfo(core);
    owner = account?.owner.toBase58() ?? null;
    coreData = account?.data ?? null;
    if (owner === CORE_PROGRAM_ID.toBase58()) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const undelegated = owner === CORE_PROGRAM_ID.toBase58();
  const view = undelegated && coreData ? decodeIncidentCore(coreData) : null;
  say(
    `  owner ${owner} status ${view ? IncidentStatus[view.status] : "?"} approvals ${view?.approvalCountAfterTerminal ?? "?"} rejections ${view?.rejectionCountAfterTerminal ?? "?"}`,
  );

  const canaries = [CANARY_CLAIM, CANARY_NOTES];
  const scanned: string[] = [];
  for (const [label, address] of [
    ["core", core],
    ["claim", claim],
    ...members.map(
      (m, i) => [`ballot-${names[i]}`, attestationAddress(core, m.publicKey)] as const,
    ),
  ] as const) {
    const account = await base.getAccountInfo(address);
    if (!account) continue;
    const hex = account.data.toString("hex");
    for (const canary of canaries) {
      if (hex.includes(Buffer.from(canary, "utf8").toString("hex"))) scanned.push(label);
    }
  }

  const mechanicsWork = undelegated && view?.status === IncidentStatus.CertifiedPendingSettlement;
  const peersBlind =
    !matrix.alphaReadsBetaBallot.readable &&
    !matrix.betaReadsAlphaBallot.readable &&
    !matrix.openerReadsAlphaBallot.readable &&
    !matrix.outsiderReadsAlphaBallot.readable;
  const verdict =
    mechanicsWork && scanned.length === 0
      ? peersBlind
        ? "PASS"
        : "MECHANICS_PASS_READS_NOT_ENFORCED"
      : "FAIL";

  say(`\nLocal lifecycle: ${verdict}`);
  if (!peersBlind) {
    say(
      "  the local query-filtering service did not refuse a peer's ballot; the read boundary is only established by the Devnet run",
    );
  }

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const body = `${JSON.stringify(
    {
      captured_at: capturedAt,
      verdict,
      what_this_proves:
        "The lifecycle mechanics: five accounts delegated, three permissions created by CPI, certification over every ballot passed at once, a per-account scrub, and one intent committing and undelegating all five.",
      what_this_does_not_prove:
        "Anything about a TEE. There is no enclave here and no attestation. A passing read matrix says the reference query-filtering service behaves as expected, not that a confidential runtime is holding the line.",
      endpoints: { base: BASE_RPC, er: ER_RPC, qfs: QFS_RPC },
      validator: validator.toBase58(),
      accounts: {
        core: core.toBase58(),
        claim: claim.toBase58(),
        ballots: memberKeys.map((k) => attestationAddress(core, k).toBase58()),
      },
      read_matrix: matrix,
      peers_blind: peersBlind,
      base_state: {
        owner,
        undelegated,
        status: view ? IncidentStatus[view.status] : null,
        approvals: view?.approvalCountAfterTerminal ?? null,
        rejections: view?.rejectionCountAfterTerminal ?? null,
      },
      canary_findings: scanned,
      transcript: log,
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(ARTIFACT_DIR, "phase4-local-lifecycle.json"), body);
  say("\nWrote artifacts/local-stack/phase4-local-lifecycle.json");
  if (verdict === "FAIL") process.exitCode = 1;
}

await main();

/**
 * The Phase 4 private incident lifecycle, run against a TEE-backed Devnet PER.
 *
 * The script's job is to produce evidence about a boundary, so it is written to observe
 * rather than to assert. Every private field class carries its own canary, every surface
 * that could carry one is scanned afterwards, and the leak scan is written out as a
 * machine-readable artifact whether it passes or not.
 *
 * The property under test is sealed quorum: a member learns their own submission was
 * accepted and nothing else. Not another member's decision, not the running count. That
 * rests on the state being split across a public core, a claim private to the member set,
 * and one attestation per member private to that member alone, with no account anywhere
 * holding a live tally. See docs/decision-log.md D-0042 and D-0043.
 *
 * Two things it will not do. It will not pick a rollup by name: the TEE-backed endpoint is
 * whichever router-advertised route returns a genuine TDX quote bound to a fresh challenge.
 * And it will not collect proof artifacts from a rollup whose build fingerprint disagrees
 * with the base-layer deployment, because Phase 3 spent an afternoon reading application
 * meaning into a stale program clone. See D-0030.
 *
 *   pnpm exec tsx scripts/phase4-per.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  verifyTeeRpcIntegrity,
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
  CORE_IDL,
  CORE_PROGRAM_ID,
  Decision,
  MemberRole,
  addCovenantMember,
  armCovenant,
  armCovenantMember,
  canonicalMemberOrder,
  covenantAddress,
  createCovenant,
  ratifyCovenant,
  ratifyCovenantMember,
  IncidentStatus,
  attestationAddress,
  authenticate,
  certifyIncident,
  claimAddress,
  closeAttestationPermission,
  closeClaimPermission,
  commitIncident,
  createAttestationPermission,
  createClaimPermission,
  decodeIncidentCore,
  delegateAttestation,
  delegateClaim,
  delegateIncident,
  errorName,
  incidentAddress,
  initializeAttestation,
  initializeClaim,
  initializeIncident,
  interactionOnly,
  openIncident,
  permissionAddress,
  quarantineMember,
  releaseIncident,
  scrubAttestation,
  scrubClaim,
  submitPrivateClaim,
  submitSealedAttestation,
  type AuthenticatedEndpoint,
} from "../packages/client/src/index.js";
import { checkRuntimeFreshness } from "../packages/client/src/freshness.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "devnet");

const BASE_RPC = process.env.VINCT_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
const ROUTER = process.env.VINCT_ROUTER ?? "https://devnet-router.magicblock.app/";
const KEYPAIR = process.env.VINCT_KEYPAIR ?? ".toolchain/keys/devnet-deployer.json";
const RUN_LABEL = process.env.VINCT_RUN_LABEL ?? "phase4-per";
const NETWORK_LABEL = process.env.VINCT_NETWORK ?? "solana-devnet";
const OBSERVATION_WINDOW_MS = 150_000;
const OBSERVATION_INTERVAL_MS = 3_000;

// --------------------------------------------------------------- the canaries

/**
 * One marker per private field class.
 *
 * Distinct so a partial leak names itself. A single shared marker would tell us that
 * something escaped without telling us what, and "some private field leaked" is not a
 * finding anyone can act on.
 */
const CANARY = {
  claim: `VINCT-PER-CANARY-CLAIM-${RUN_LABEL}-4f2a9c1e`,
  notes: `VINCT-PER-CANARY-NOTES-${RUN_LABEL}-7b3d5e08`,
} as const;
const CANARY_OBSERVATION_START = 0x5641_4e41_5259_0001n;
const CANARY_OBSERVATION_END = 0x5641_4e41_5259_0002n;
const CANARY_NONCE_BASE = 0xc0ff_ee00_0000_0000n;
/** Two of the three members submit. Two meets the threshold; the third stays silent. */
const ATTESTING_MEMBERS = 2;

interface CanaryPattern {
  field: string;
  needles: string[];
}

function canaryPatterns(): CanaryPattern[] {
  const forText = (field: string, text: string): CanaryPattern => ({
    field,
    needles: [
      text,
      Buffer.from(text, "utf8").toString("hex"),
      Buffer.from(text, "utf8").toString("base64"),
    ],
  });
  const forU64 = (field: string, value: bigint): CanaryPattern => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt.asUintN(64, value));
    return {
      field,
      needles: [buffer.toString("hex"), buffer.toString("base64"), value.toString()],
    };
  };

  const patterns = [
    forText("private_claim", CANARY.claim),
    forText("private_notes", CANARY.notes),
    forU64("private_observation_start", CANARY_OBSERVATION_START),
    forU64("private_observation_end", CANARY_OBSERVATION_END),
  ];
  for (let index = 0; index < ATTESTING_MEMBERS; index += 1) {
    patterns.push(forU64(`attestation_nonce_${index}`, CANARY_NONCE_BASE + BigInt(index) + 1n));
  }
  return patterns;
}

// ------------------------------------------------------------------ recording

interface Step {
  step: string;
  runtime: "base" | "er" | "none";
  signature?: string;
  detail?: unknown;
}

const steps: Step[] = [];
const consoleTranscript: string[] = [];

function say(line: string): void {
  consoleTranscript.push(line);
  console.log(line);
}

function record(step: Step): void {
  steps.push(step);
  const where = step.runtime === "none" ? "" : ` [${step.runtime}]`;
  say(`  ${step.step}${where}${step.signature ? ` ${step.signature}` : ""}`);
}

function sha256(input: Buffer | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

function derivedKeypair(seed: string): Keypair {
  return Keypair.fromSeed(sha256(seed).slice(0, 32));
}

// ------------------------------------------------------------------- sending

const baseSignatures: string[] = [];
const ephemeralSignatures: string[] = [];

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
  (runtime === "base" ? baseSignatures : ephemeralSignatures).push(signature);
  record({ step: label, signature, runtime });
  return signature;
}

async function sendIdempotent(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  label: string,
  runtime: "base" | "er" = "base",
): Promise<string | null> {
  try {
    return await send(connection, instructions, signers, label, runtime);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("already in use") || message.includes("custom program error: 0x0")) {
      record({ step: `${label} (already existed)`, runtime: "none" });
      return null;
    }
    throw cause;
  }
}

/**
 * Turns a landed transaction's `InstructionError` into the program's own error name.
 *
 * The reason usually comes from a log line, but this rollup withholds logs from members
 * holding no visibility flags, which is the configuration VINCT chose. The error code
 * survives, so the name is recovered from the IDL instead of from text the permission is
 * doing its job by hiding.
 */
function namedInstructionError(err: unknown): string | null {
  if (!err) return null;
  const instructionError = (err as { InstructionError?: [number, unknown] }).InstructionError;
  const custom = (instructionError?.[1] as { Custom?: number } | undefined)?.Custom;
  if (typeof custom === "number") {
    return errorName(CORE_IDL, custom) ?? `custom error ${custom}`;
  }
  return JSON.stringify(err);
}

function failureName(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const match = /custom program error: (0x[0-9a-fA-F]+)/.exec(message);
  if (match?.[1]) {
    const name = errorName(CORE_IDL, Number.parseInt(match[1], 16));
    if (name) return name;
  }
  const logs = (cause as { logs?: string[] })?.logs ?? [];
  for (const line of logs) {
    const anchor = /Error Code: (\w+)/.exec(line);
    if (anchor?.[1]) return anchor[1];
  }
  return message.split("\n")[0] ?? message;
}

async function refusalReason(
  connection: Connection,
  cause: unknown,
): Promise<{ reason: string; signature?: string }> {
  const direct = failureName(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  const signature = /Transaction ([1-9A-HJ-NP-Za-km-z]{80,}) resulted in an error/.exec(
    message,
  )?.[1];
  if (!signature) return { reason: direct };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const transaction = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      for (const line of transaction?.meta?.logMessages ?? []) {
        const anchor = /Error Code: (\w+)/.exec(line);
        if (anchor?.[1]) return { reason: anchor[1], signature };
      }
      const named = namedInstructionError(transaction?.meta?.err);
      if (named) return { reason: named, signature };
    } catch {
      // The rollup may not have indexed it yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return { reason: direct, signature };
}

interface Refusal {
  attempt: string;
  refused: boolean;
  reason: string;
  expected: string;
  reasonMatched: boolean;
  signature?: string;
}

const refusals: Refusal[] = [];

async function expectRefusal(
  attempt: string,
  expected: string,
  connection: Connection,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    refusals.push({
      attempt,
      refused: false,
      reason: "the attempt succeeded",
      expected,
      reasonMatched: false,
    });
    record({ step: `${attempt}: ACCEPTED (unexpected)`, runtime: "none" });
  } catch (cause) {
    const { reason, signature } = await refusalReason(connection, cause);
    const reasonMatched = reason === expected;
    refusals.push({
      attempt,
      refused: true,
      reason,
      expected,
      reasonMatched,
      ...(signature ? { signature } : {}),
    });
    record({
      step: `${attempt}: refused (${reason})${reasonMatched ? "" : ` — expected ${expected}`}`,
      runtime: "none",
    });
  }
}

// ------------------------------------------------------------------- routing

interface RouterRoute {
  identity: string;
  fqdn: string;
}

async function routerCall(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ROUTER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  return body.error === undefined ? (body.result ?? null) : null;
}

async function rpc(endpoint: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(JSON.stringify(body.error));
  return body.result ?? null;
}

interface TeeCandidate {
  fqdn: string;
  identity: string;
  attested: boolean;
  attestationError?: string;
}

/**
 * Finds the TEE-backed rollups among whatever the router currently advertises.
 *
 * The discriminator is a live one: `verifyTeeRpcIntegrity` asks the endpoint for a TDX quote
 * over a fresh 64-byte challenge and verifies that the quote's report data is that exact
 * challenge. A non-TEE rollup has nothing to answer with. No region name, country code, or
 * hostname appears in this decision.
 *
 * Precise about what this establishes: a genuine quote, bound to this challenge, from
 * hardware that Intel's chain vouches for. It does not compare MRTD or RTMR values against
 * an expected workload, so it does not prove which code is running inside that enclave.
 */
async function findTeeBackedRollups(): Promise<TeeCandidate[]> {
  const routes = ((await routerCall("getRoutes")) ?? []) as RouterRoute[];
  const candidates: TeeCandidate[] = [];
  for (const route of routes) {
    const base = route.fqdn.replace(/\/$/, "");
    try {
      await verifyTeeRpcIntegrity(base);
      candidates.push({ fqdn: route.fqdn, identity: route.identity, attested: true });
    } catch (cause) {
      candidates.push({
        fqdn: route.fqdn,
        identity: route.identity,
        attested: false,
        attestationError: cause instanceof Error ? cause.message : JSON.stringify(cause),
      });
    }
  }
  return candidates;
}

// -------------------------------------------------------------- the leak scan

interface ScannedSurface {
  surface: string;
  description: string;
  content: string | null;
  unavailableReason?: string;
}

interface LeakFinding {
  surface: string;
  field: string;
  encoding: string;
}

function scanSurfaces(surfaces: ScannedSurface[]): {
  findings: LeakFinding[];
  unreadable: string[];
} {
  const patterns = canaryPatterns();
  const findings: LeakFinding[] = [];
  const unreadable: string[] = [];
  for (const surface of surfaces) {
    if (surface.content === null) {
      unreadable.push(surface.surface);
      continue;
    }
    const haystack = surface.content.toLowerCase();
    for (const pattern of patterns) {
      for (const needle of pattern.needles) {
        if (needle.length >= 8 && haystack.includes(needle.toLowerCase())) {
          findings.push({
            surface: surface.surface,
            field: pattern.field,
            encoding: needle === pattern.needles[0] ? "utf8" : "encoded",
          });
          break;
        }
      }
    }
  }
  return { findings, unreadable };
}

async function fetchTransactions(endpoint: string, signatures: string[]): Promise<string | null> {
  if (signatures.length === 0) return "";
  const parts: string[] = [];
  for (const signature of signatures) {
    try {
      const result = await rpc(endpoint, "getTransaction", [
        signature,
        { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ]);
      parts.push(JSON.stringify(result));
    } catch (cause) {
      parts.push(JSON.stringify({ signature, unavailable: String(cause) }));
    }
  }
  return parts.join("\n");
}

async function fetchAccount(endpoint: string, address: PublicKey): Promise<string | null> {
  try {
    const result = (await rpc(endpoint, "getAccountInfo", [
      address.toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ])) as { value?: { data?: [string, string] } } | null;
    const encoded = result?.value?.data?.[0];
    if (encoded === undefined) return JSON.stringify(result);
    return `${encoded}\n${Buffer.from(encoded, "base64").toString("hex")}`;
  } catch (cause) {
    return `ERROR ${String(cause)}`;
  }
}

/**
 * Describes a read without reproducing its bytes.
 *
 * The summary goes into an artifact. If it carried the account's contents, a successful leak
 * test would write the leak into the file that certifies there was none.
 */
function summarizeRead(read: string | null): {
  available: boolean;
  byteLength?: number;
  allZero?: boolean;
  digest?: string;
  note?: string;
  error?: string;
} {
  if (read === null) return { available: false };
  if (read.startsWith("ERROR")) return { available: false, error: read.slice(0, 200) };
  const [encoded] = read.split("\n");
  if (encoded === undefined || encoded.length === 0) {
    return { available: false, note: "the rollup returned no account data" };
  }
  try {
    const bytes = Buffer.from(encoded, "base64");
    return {
      available: true,
      byteLength: bytes.length,
      allZero: bytes.every((b) => b === 0),
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { available: true, note: "the response was not account data" };
  }
}

async function readThroughSession(
  connection: Connection,
  address: PublicKey,
): Promise<string | null> {
  try {
    const account = await connection.getAccountInfo(address, "confirmed");
    if (!account) return null;
    return `${account.data.toString("base64")}\n${account.data.toString("hex")}`;
  } catch (cause) {
    return `ERROR ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

// ------------------------------------------------------------------ main flow

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString();
  const base = new Connection(BASE_RPC, "confirmed");
  const payer = loadKeypair(join(REPO_ROOT, KEYPAIR));

  const genesisHash = await base.getGenesisHash();
  const clusterGenesisHash = new PublicKey(genesisHash).toBytes();

  const steward = derivedKeypair(`${RUN_LABEL}:steward`);
  const covenantId = BigInt(Number.parseInt(process.env.VINCT_INCIDENT_ID ?? "1", 10));
  const covenant = covenantAddress(steward.publicKey, covenantId);
  const policyId = sha256(`${RUN_LABEL}:policy`);
  const incidentId = BigInt(Number.parseInt(process.env.VINCT_INCIDENT_ID ?? "1", 10));
  const core = incidentAddress(covenant, incidentId);
  const claim = claimAddress(core);

  const memberNames = ["alpha", "beta", "gamma"] as const;
  const members = memberNames.map((name) => derivedKeypair(`${RUN_LABEL}:member:${name}`));
  const memberKeys = members.map((m) => m.publicKey);
  const outsider = derivedKeypair(`${RUN_LABEL}:outsider`);

  say(`VINCT Phase 4 — sealed-quorum incident lifecycle (${RUN_LABEL})`);
  say(`  base      ${BASE_RPC}`);
  say(`  router    ${ROUTER}`);
  say(`  payer     ${payer.publicKey.toBase58()}`);
  say(`  covenant  ${covenant.toBase58()}`);
  say(`  core      ${core.toBase58()}   (public)`);
  say(`  claim     ${claim.toBase58()}   (private to the member set)`);
  for (const [index, member] of members.entries()) {
    say(
      `  ballot ${memberNames[index]?.padEnd(6)} ${attestationAddress(core, member.publicKey).toBase58()}   (private to ${member.publicKey.toBase58().slice(0, 8)}…)`,
    );
  }
  say("");

  // ------------------------------------------------- attested rollup selection

  say("Selecting a TEE-backed rollup from live routing");
  const candidates = await findTeeBackedRollups();
  for (const candidate of candidates) {
    say(`  ${candidate.fqdn.padEnd(40)} ${candidate.attested ? "TDX quote verified" : "no quote"}`);
  }
  const attested = candidates.filter((c) => c.attested);
  record({ step: "TEE candidate scan", runtime: "none", detail: candidates });
  if (attested.length === 0) {
    throw new Error(
      "no router-advertised rollup returned a verifiable TDX quote; the PER gate is unreachable right now",
    );
  }

  // ---------------------------------------------------------- freshness gate

  say("\nChecking runtime freshness before anything is proven");
  let selected: TeeCandidate | null = null;
  let freshness: Awaited<ReturnType<typeof checkRuntimeFreshness>> | null = null;
  const freshnessAttempts: unknown[] = [];

  for (const candidate of attested) {
    const connection = new Connection(candidate.fqdn, "confirmed");
    const report = await checkRuntimeFreshness({
      base,
      baseEndpoint: BASE_RPC,
      ephemeral: connection,
      ephemeralEndpoint: candidate.fqdn,
      feePayer: payer.publicKey,
    });
    freshnessAttempts.push({ endpoint: candidate.fqdn, report });
    say(`  ${candidate.fqdn.padEnd(40)} ${report.verdict}`);
    if (report.fresh) {
      selected = candidate;
      freshness = report;
      break;
    }
    say(`    ${report.note}`);
  }

  record({ step: "runtime freshness", runtime: "none", detail: freshnessAttempts });
  if (!selected || !freshness) {
    writeArtifact({
      capturedAt,
      verdict: "BLOCKED_STALE_RUNTIME",
      candidates,
      freshnessAttempts,
    });
    throw new Error(
      "no attested rollup is running the current build; artifacts were not collected. Upgrade base, or wait for the rollup to refresh its clone.",
    );
  }

  const erEndpoint = selected.fqdn;
  const validator = new PublicKey(selected.identity);
  say(`  using ${erEndpoint} (validator ${selected.identity})`);

  // --------------------------------------------------------------- funding

  say("\nFunding member keys");
  const fundingAmount = 8_000_000;
  const funding: TransactionInstruction[] = [];
  for (const member of [...members, outsider, steward]) {
    if ((await base.getBalance(member.publicKey)) < fundingAmount / 2) {
      funding.push(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: member.publicKey,
          lamports: fundingAmount,
        }),
      );
    }
  }
  if (funding.length > 0) {
    await send(base, funding, [payer], "fund member keys", "base");
  } else {
    record({ step: "member keys already funded", runtime: "none" });
  }

  // ------------------------------------------------ signed client authentication

  say("\nAuthenticating every participant separately against the rollup");
  const sessions = new Map<string, AuthenticatedEndpoint>();
  for (const keypair of [payer, ...members, outsider]) {
    sessions.set(keypair.publicKey.toBase58(), await authenticate(erEndpoint, keypair));
  }
  const session = (keypair: Keypair): Connection => {
    const entry = sessions.get(keypair.publicKey.toBase58());
    if (!entry) throw new Error(`no session for ${keypair.publicKey.toBase58()}`);
    return entry.connection;
  };
  record({
    step: "signed client authentication",
    runtime: "none",
    detail: {
      note: "Each key completed the rollup's challenge/sign/login flow and holds its own session. Tokens are never recorded.",
      authenticated: [...sessions.values()].map((entry) => ({
        pubkey: entry.publicKey.toBase58(),
        endpoint: entry.redactedUrl,
        expires_at: new Date(entry.expiresAt).toISOString(),
      })),
    },
  });
  const er = session(payer);

  // ------------------------------------------------- base: create and delegate

  // ------------------------------------------------------ covenant formation
  //
  // Every step needs a different signature. The steward convenes and adds and can do nothing
  // else; each protocol ratifies and arms its own membership; the two covenant-level steps
  // take no signer, because by then every signature that mattered has been given.

  say("\nForming the covenant");
  await sendIdempotent(
    base,
    [
      createCovenant(steward.publicKey, {
        covenantId,
        circleEpoch: 1n,
        clusterGenesisHash,
        policyId,
        actionBundleTemplateHash: sha256(`${RUN_LABEL}:template`),
        requiredApprovals: 2,
        maximumRejections: 1,
        responseWindowSlots: 200_000n,
        certificateLifetimeSlots: 100_000n,
        epochLifetimeSlots: 10_000_000n,
      }),
    ],
    [steward],
    "convene the covenant",
  );
  for (const member of canonicalMemberOrder(memberKeys)) {
    await sendIdempotent(
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
    );
  }
  for (const [index, member] of members.entries()) {
    await sendIdempotent(
      base,
      [ratifyCovenantMember(covenant, member.publicKey)],
      [member],
      `${memberNames[index]} ratifies`,
    );
  }
  await sendIdempotent(base, [ratifyCovenant(covenant, memberKeys)], [payer], "covenant ratifies");
  for (const [index, member] of members.entries()) {
    await sendIdempotent(
      base,
      [armCovenantMember(covenant, member.publicKey, 1)],
      [member],
      `${memberNames[index]} arms`,
    );
  }
  await sendIdempotent(base, [armCovenant(covenant)], [payer], "covenant arms");

  // The opener is a covenant member, because opening now needs a ratified membership. That
  // also sharpens the read matrix below: the principal who cannot read a peer's ballot is a
  // peer rather than an outsider.
  const opener = members[0]!;

  say("\nCreating the incident's accounts on base");
  await sendIdempotent(
    base,
    [initializeIncident(opener.publicKey, covenant, incidentId)],
    [opener],
    "initialize public core",
  );
  await sendIdempotent(
    base,
    [initializeClaim(core, opener.publicKey)],
    [opener],
    "initialize claim",
  );
  for (const [index, member] of members.entries()) {
    await sendIdempotent(
      base,
      [initializeAttestation(core, covenant, opener.publicKey, member.publicKey)],
      [opener],
      `initialize ${memberNames[index]}'s attestation`,
    );
  }

  const delegationFor = (account: PublicKey) => ({
    buffer: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(account, CORE_PROGRAM_ID),
    record: delegationRecordPdaFromDelegatedAccount(account),
    metadata: delegationMetadataPdaFromDelegatedAccount(account),
    delegationProgram: DELEGATION_PROGRAM_ID,
  });
  const isDelegated = async (account: PublicKey): Promise<boolean> =>
    (await base.getAccountInfo(account))?.owner.toBase58() === DELEGATION_PROGRAM_ID.toBase58();

  say("\nDelegating every account to the attested validator");
  if (!(await isDelegated(core))) {
    await send(
      base,
      [delegateIncident(opener.publicKey, covenant, incidentId, validator, delegationFor(core))],
      [opener],
      "delegate the public core",
      "base",
    );
  }
  if (!(await isDelegated(claim))) {
    await send(
      base,
      [delegateClaim(opener.publicKey, core, validator, delegationFor(claim))],
      [opener],
      "delegate the claim",
      "base",
    );
  }
  for (const [index, member] of members.entries()) {
    const attestation = attestationAddress(core, member.publicKey);
    if (!(await isDelegated(attestation))) {
      await send(
        base,
        [
          delegateAttestation(
            opener.publicKey,
            core,
            member.publicKey,
            validator,
            delegationFor(attestation),
          ),
        ],
        [opener],
        `delegate ${memberNames[index]}'s attestation`,
        "base",
      );
    }
  }

  // ------------------------------------------------- ER: the permissions

  say("\nCreating permissions: the claim to the member set, each ballot to its own member");
  await sendIdempotent(
    er,
    [
      createClaimPermission(
        core,
        payer.publicKey,
        [payer, ...members].map((k) => interactionOnly(k.publicKey)),
      ),
    ],
    [payer],
    "claim permission (members: the responder and the circle)",
    "er",
  );
  for (const [index, member] of members.entries()) {
    await sendIdempotent(
      er,
      [createAttestationPermission(core, member.publicKey)],
      [payer],
      `${memberNames[index]}'s ballot permission (member: ${memberNames[index]} alone)`,
      "er",
    );
  }

  // ------------------------------------------------------- ER: the incident

  say("\nOpening the incident and collecting sealed attestations");
  await sendIdempotent(
    er,
    [openIncident(core, opener.publicKey, memberKeys, sha256(CANARY.claim))],
    [opener],
    "open incident",
    "er",
  );

  await send(
    er,
    [
      submitPrivateClaim(core, opener.publicKey, {
        claim: Buffer.from(CANARY.claim, "utf8"),
        observationStart: CANARY_OBSERVATION_START,
        observationEnd: CANARY_OBSERVATION_END,
        notes: Buffer.from(CANARY.notes, "utf8"),
      }),
    ],
    [opener],
    "submit private claim",
    "er",
  );

  for (const [index, member] of members.slice(0, ATTESTING_MEMBERS).entries()) {
    await send(
      session(member),
      [
        submitSealedAttestation(
          core,
          member.publicKey,
          Decision.Approve,
          CANARY_NONCE_BASE + BigInt(index) + 1n,
        ),
      ],
      [member],
      `${memberNames[index]}: sealed attestation`,
      "er",
    );
  }
  say(`  ${memberNames[2]} stays silent, and certification must not wait for them`);

  // ------------------------------------------- the sealed-quorum observations

  say("\nWho can read what, one principal at a time");
  const attestationOf = (index: number): PublicKey =>
    attestationAddress(core, members[index]!.publicKey);

  const sealedQuorum = {
    note: "Each read is taken through that wallet's own authenticated session, one call apart.",
    alphaOwnBallot: summarizeRead(await readThroughSession(session(members[0]!), attestationOf(0))),
    alphaReadsBetaBallot: summarizeRead(
      await readThroughSession(session(members[0]!), attestationOf(1)),
    ),
    betaOwnBallot: summarizeRead(await readThroughSession(session(members[1]!), attestationOf(1))),
    betaReadsAlphaBallot: summarizeRead(
      await readThroughSession(session(members[1]!), attestationOf(0)),
    ),
    openerReadsAlphaBallot: summarizeRead(
      await readThroughSession(session(payer), attestationOf(0)),
    ),
    outsiderReadsAlphaBallot: summarizeRead(
      await readThroughSession(session(outsider), attestationOf(0)),
    ),
    memberReadsClaim: summarizeRead(await readThroughSession(session(members[0]!), claim)),
    outsiderReadsClaim: summarizeRead(await readThroughSession(session(outsider), claim)),
    anyoneReadsCore: summarizeRead(await readThroughSession(session(outsider), core)),
    anonymousReadsClaim: summarizeRead(await fetchAccount(erEndpoint, claim)),
    anonymousReadsAlphaBallot: summarizeRead(await fetchAccount(erEndpoint, attestationOf(0))),
  };
  for (const [label, result] of Object.entries(sealedQuorum)) {
    if (label === "note") continue;
    const summary = result as { available: boolean; byteLength?: number };
    say(
      `  ${label.padEnd(26)} ${summary.available ? `READABLE (${summary.byteLength} bytes)` : "refused"}`,
    );
  }
  record({ step: "sealed-quorum read matrix", runtime: "none", detail: sealedQuorum });

  // The positive control. Every canary has to be demonstrably inside the private runtime
  // before the scrub, or "no canary found anywhere public" is a statement about a marker that
  // was never written. A scan with nothing to find always passes.
  const control = scanSurfaces([
    {
      surface: "er:claim-member-session",
      description: "The live claim, read by a member of its permission.",
      content: await readThroughSession(session(members[0]!), claim),
    },
    {
      surface: "er:ballot-alpha-own-session",
      description: "Alpha's live ballot, read by alpha.",
      content: await readThroughSession(session(members[0]!), attestationOf(0)),
    },
    {
      surface: "er:ballot-beta-own-session",
      description: "Beta's live ballot, read by beta.",
      content: await readThroughSession(session(members[1]!), attestationOf(1)),
    },
  ]);
  const controlFields = new Set(control.findings.map((f) => f.field));
  const missingControls = canaryPatterns()
    .map((p) => p.field)
    .filter((field) => !controlFields.has(field));
  record({
    step: "leak-scan positive control",
    runtime: "none",
    detail: {
      note: "Each private field class must be visible to the principal entitled to it before the scrub, or the leak scan proves nothing.",
      present: [...controlFields],
      missing: missingControls,
    },
  });

  // ---------------------------------------------------------- the refusals

  say("\nAttempting everything the boundary is supposed to refuse");

  await expectRefusal(
    "an authenticated non-member submits an attestation",
    "ConstraintSeeds",
    session(outsider),
    () =>
      send(
        session(outsider),
        [submitSealedAttestation(core, outsider.publicKey, Decision.Approve, 1n)],
        [outsider],
        "outsider attestation",
        "er",
      ),
  );

  await expectRefusal(
    "a member replays a submission nonce",
    "NonceNotIncreasing",
    session(members[0]!),
    () =>
      send(
        session(members[0]!),
        [
          submitSealedAttestation(
            core,
            members[0]!.publicKey,
            Decision.Reject,
            CANARY_NONCE_BASE + 1n,
          ),
        ],
        [members[0]!],
        "duplicate nonce",
        "er",
      ),
  );

  await expectRefusal(
    "a non-opener quarantines a member",
    "NotTheOpener",
    session(members[1]!),
    () =>
      send(
        session(members[1]!),
        [quarantineMember(core, members[1]!.publicKey, members[2]!.publicKey)],
        [members[1]!],
        "unauthorized quarantine",
        "er",
      ),
  );

  await expectRefusal("an unsanitized incident is committed", "PrivateFieldsNotZeroized", er, () =>
    send(
      er,
      [commitIncident(payer.publicKey, covenant, incidentId, memberKeys)],
      [payer],
      "unsanitized commit",
      "er",
    ),
  );

  await expectRefusal("an unsanitized incident is released", "PrivateFieldsNotZeroized", er, () =>
    send(
      er,
      [releaseIncident(payer.publicKey, covenant, incidentId, memberKeys)],
      [payer],
      "unsanitized release",
      "er",
    ),
  );

  await expectRefusal(
    "the claim's permission is closed while the evidence is live",
    "PrivateFieldsNotZeroized",
    er,
    () => send(er, [closeClaimPermission(core)], [payer], "premature claim permission close", "er"),
  );

  await expectRefusal(
    "certification is attempted with a member's ballot left out",
    "AttestationCountMismatch",
    er,
    () =>
      send(
        er,
        [certifyIncident(core, memberKeys.slice(0, 2))],
        [payer],
        "short certification",
        "er",
      ),
  );

  // ------------------------------------------------------ certify and release

  say("\nCertifying: every ballot counted at once, nothing accumulated anywhere");
  await send(er, [certifyIncident(core, memberKeys)], [payer], "certify incident", "er");

  say("\nScrubbing and releasing");
  await send(er, [scrubClaim(core)], [payer], "scrub the claim", "er");
  for (const [index, member] of members.entries()) {
    await send(
      er,
      [scrubAttestation(core, member.publicKey)],
      [payer],
      `scrub ${memberNames[index]}'s ballot`,
      "er",
    );
  }
  await send(er, [closeClaimPermission(core)], [payer], "close the claim permission", "er");
  for (const [index, member] of members.entries()) {
    await send(
      er,
      [closeAttestationPermission(core, member.publicKey)],
      [payer],
      `close ${memberNames[index]}'s ballot permission`,
      "er",
    );
  }
  await send(
    er,
    [releaseIncident(payer.publicKey, covenant, incidentId, memberKeys)],
    [payer],
    "release the whole incident",
    "er",
  );

  // ------------------------------------------------------- base observation

  say("\nObserving base propagation");
  const deadline = Date.now() + OBSERVATION_WINDOW_MS;
  let baseOwner: string | null = null;
  let coreData: Buffer | null = null;
  while (Date.now() < deadline) {
    const account = await base.getAccountInfo(core);
    baseOwner = account?.owner.toBase58() ?? null;
    coreData = account?.data ?? null;
    if (baseOwner === CORE_PROGRAM_ID.toBase58()) break;
    await new Promise((resolve) => setTimeout(resolve, OBSERVATION_INTERVAL_MS));
  }
  const undelegated = baseOwner === CORE_PROGRAM_ID.toBase58();
  const coreView = undelegated && coreData ? decodeIncidentCore(coreData) : null;
  const claimData = (await base.getAccountInfo(claim))?.data ?? null;
  const attestationData: Buffer[] = [];
  for (const member of members) {
    const account = await base.getAccountInfo(attestationAddress(core, member.publicKey));
    if (account) attestationData.push(account.data);
  }
  record({
    step: "base state after release",
    runtime: "none",
    detail: {
      owner: baseOwner,
      undelegated,
      status: coreView ? IncidentStatus[coreView.status] : null,
      approvals: coreView?.approvalCountAfterTerminal ?? null,
      rejections: coreView?.rejectionCountAfterTerminal ?? null,
      attestations_on_base: attestationData.length,
    },
  });

  await expectRefusal(
    "a terminal incident accepts a replayed attestation",
    "IncidentNotCollecting",
    session(members[2]!),
    () =>
      send(
        session(members[2]!),
        [
          submitSealedAttestation(
            core,
            members[2]!.publicKey,
            Decision.Approve,
            CANARY_NONCE_BASE + 9n,
          ),
        ],
        [members[2]!],
        "post-terminal replay",
        "er",
      ),
  );

  // ------------------------------------------------------------- leak scan

  say("\nScanning every surface for a canary");
  const surfaces: ScannedSurface[] = [
    {
      surface: "base:core-account",
      description: "The public incident core as it now sits on the base layer.",
      content: coreData ? `${coreData.toString("base64")}\n${coreData.toString("hex")}` : null,
      ...(coreData ? {} : { unavailableReason: "the core did not return to base ownership" }),
    },
    {
      surface: "base:claim-account",
      description: "The claim account on the base layer, after the scrub.",
      content: claimData ? `${claimData.toString("base64")}\n${claimData.toString("hex")}` : null,
      ...(claimData ? {} : { unavailableReason: "the claim did not return to base ownership" }),
    },
    {
      surface: "base:attestation-accounts",
      description: "Every member attestation on the base layer, after the scrub.",
      content:
        attestationData.length > 0
          ? attestationData.map((d) => `${d.toString("base64")}\n${d.toString("hex")}`).join("\n")
          : null,
      ...(attestationData.length > 0
        ? {}
        : { unavailableReason: "no attestation returned to base ownership" }),
    },
    {
      surface: "base:transactions",
      description: "Every base transaction this run sent, message and logs.",
      content: await fetchTransactions(BASE_RPC, baseSignatures),
    },
    {
      surface: "er:transactions-anonymous",
      description:
        "Every ER transaction this run sent, read back with no credential of any kind. This is what a passer-by sees.",
      content: await fetchTransactions(erEndpoint, ephemeralSignatures),
    },
    {
      surface: "er:claim-anonymous",
      description: "The claim account read from the rollup with no credential.",
      content: await fetchAccount(erEndpoint, claim),
    },
    {
      surface: "er:ballots-anonymous",
      description: "Every ballot read from the rollup with no credential.",
      content: (
        await Promise.all(
          members.map((m) => fetchAccount(erEndpoint, attestationAddress(core, m.publicKey))),
        )
      ).join("\n"),
    },
    {
      surface: "er:permissions-anonymous",
      description: "The claim and ballot permission accounts, read with no credential.",
      content: (
        await Promise.all(
          [claim, ...members.map((m) => attestationAddress(core, m.publicKey))].map((account) =>
            fetchAccount(erEndpoint, permissionAddress(account)),
          ),
        )
      ).join("\n"),
    },
    {
      surface: "artifact:run-record",
      description: "The artifact this script is about to write.",
      content: JSON.stringify(steps),
    },
    {
      surface: "process:stdout",
      description: "Everything this script printed to the terminal.",
      content: consoleTranscript.join("\n"),
    },
  ];

  const scan = scanSurfaces(surfaces);
  for (const finding of scan.findings) {
    say(`  LEAK ${finding.surface} carries ${finding.field} (${finding.encoding})`);
  }
  if (scan.findings.length === 0) {
    say(`  no canary found on ${surfaces.length - scan.unreadable.length} readable surfaces`);
  }
  for (const surface of scan.unreadable) {
    say(`  UNREADABLE ${surface} — recorded as unproven, not as clean`);
  }

  // ---------------------------------------------------------------- verdict

  const unrefused = refusals.filter((r) => !r.refused);
  const wrongReason = refusals.filter((r) => r.refused && !r.reasonMatched);
  const peersBlind =
    !sealedQuorum.alphaReadsBetaBallot.available &&
    !sealedQuorum.betaReadsAlphaBallot.available &&
    !sealedQuorum.openerReadsAlphaBallot.available &&
    !sealedQuorum.outsiderReadsAlphaBallot.available;
  const ownBallotsVisible =
    sealedQuorum.alphaOwnBallot.available && sealedQuorum.betaOwnBallot.available;
  const claimScopedToMembers =
    sealedQuorum.memberReadsClaim.available &&
    !sealedQuorum.outsiderReadsClaim.available &&
    !sealedQuorum.anonymousReadsClaim.available;
  const coreIsPublic = sealedQuorum.anyoneReadsCore.available;
  const certifiedCorrectly =
    coreView?.status === IncidentStatus.CertifiedPendingSettlement &&
    coreView.approvalCountAfterTerminal === ATTESTING_MEMBERS &&
    coreView.rejectionCountAfterTerminal === 0;

  const verdict =
    scan.findings.length === 0 &&
    scan.unreadable.length === 0 &&
    unrefused.length === 0 &&
    wrongReason.length === 0 &&
    missingControls.length === 0 &&
    peersBlind &&
    ownBallotsVisible &&
    claimScopedToMembers &&
    coreIsPublic &&
    undelegated &&
    certifiedCorrectly
      ? "PASS"
      : "FAIL";

  for (const refusal of wrongReason) {
    say(`  WRONG REASON ${refusal.attempt}: got ${refusal.reason}, expected ${refusal.expected}`);
  }
  for (const field of missingControls) {
    say(`  CONTROL MISSING ${field} was never observed inside the private runtime`);
  }
  if (!peersBlind) say("  SEALED QUORUM BROKEN a principal read a ballot that is not theirs");
  if (!certifiedCorrectly)
    say("  CERTIFICATION WRONG the aggregate does not match the ballots cast");

  writeArtifact({
    capturedAt,
    verdict,
    architecture: {
      note: "State is split so that sealed quorum holds by construction rather than by care. See docs/decision-log.md D-0042 and D-0043.",
      public_core: core.toBase58(),
      private_claim: claim.toBase58(),
      private_ballots: members.map((m) => attestationAddress(core, m.publicKey).toBase58()),
      live_tally_account: null,
      live_tally_note:
        "There is none. Certification is passed every ballot at once and counts in memory, so no account ever holds quorum progress.",
    },
    candidates,
    freshnessAttempts,
    selectedEndpoint: erEndpoint,
    validator: selected.identity,
    freshness,
    covenant: covenant.toBase58(),
    incidentId: incidentId.toString(),
    members: memberKeys.map((k) => k.toBase58()),
    silentMember: members[2]!.publicKey.toBase58(),
    steps,
    refusals,
    sealedQuorum,
    findings: {
      peers_cannot_read_each_others_ballots: peersBlind,
      each_member_can_read_their_own_ballot: ownBallotsVisible,
      claim_is_readable_by_members_only: claimScopedToMembers,
      core_is_public: coreIsPublic,
      certification_matches_the_ballots_cast: certifiedCorrectly,
      k_of_n_liveness:
        certifiedCorrectly &&
        "one of three members never submitted, and certification did not wait for them",
    },
    baseState: {
      owner: baseOwner,
      undelegated,
      status: coreView ? IncidentStatus[coreView.status] : null,
      approvals: coreView?.approvalCountAfterTerminal ?? null,
      rejections: coreView?.rejectionCountAfterTerminal ?? null,
    },
    leakScan: {
      canary_fields: canaryPatterns().map((p) => p.field),
      surfaces: surfaces.map((s) => ({
        surface: s.surface,
        description: s.description,
        readable: s.content !== null,
        ...(s.unavailableReason ? { unavailable_reason: s.unavailableReason } : {}),
      })),
      findings: scan.findings,
      unreadable: scan.unreadable,
      positive_control: {
        note: "Field classes confirmed present inside the private runtime before the scrub. A clean scan means nothing without this.",
        present: [...controlFields],
        missing: missingControls,
      },
      not_scanned_here: [
        "browser localStorage, sessionStorage, and IndexedDB — no browser is involved in this run; Phase 7 covers them",
        "third-party telemetry — this repository sends none, which is a property of the code rather than of this run",
      ],
    },
    baseSignatures,
    ephemeralSignatures,
    network: NETWORK_LABEL,
  });

  say(`\nPhase 4 seam: ${verdict}`);
  if (verdict !== "PASS") process.exitCode = 1;
}

function writeArtifact(payload: Record<string, unknown>): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(ARTIFACT_DIR, `phase4-per-${RUN_LABEL}-${stamp}.json`), body);
  writeFileSync(join(ARTIFACT_DIR, `phase4-per-${RUN_LABEL}-latest.json`), body);
  say(`\nWrote artifacts/devnet/phase4-per-${RUN_LABEL}-latest.json`);
}

await main();

/**
 * The private incident lifecycle, client side.
 *
 * Three account classes, mirroring the program. A public core anyone may read, a claim
 * private to the incident's members, and one attestation per member private to that member
 * alone. No account holds a running tally, so there is no tally for this module to decode
 * and no convenient object that would leak one into a UI.
 *
 * Account order in every builder is the order the program declares, asserted against the
 * built IDL in `tests/program/incident-client-parity.test.ts`. Nothing here sorts a list.
 */

import {
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

import { covenantMemberAddress } from "./covenant.js";
import { expectAccount, expectVersion } from "./accounts.js";
import { ArgWriter, withDiscriminator } from "./encoding.js";
import { CORE_IDL, CORE_PROGRAM_ID, discriminator } from "./ids.js";
import { sha256 as sha256Bytes } from "./sha256.js";

export const INCIDENT_SEED = Buffer.from("incident");
export const CLAIM_SEED = Buffer.from("incident-claim");
export const ATTESTATION_SEED = Buffer.from("incident-attestation");

/** Mirrors `vinct_core::incident::Decision`. Borsh enum indices. */
export enum Decision {
  None = 0,
  Approve = 1,
  Reject = 2,
  Abstain = 3,
}

/** Mirrors `vinct_core::incident::IncidentStatus`. */
export enum IncidentStatus {
  Draft = 0,
  Collecting = 1,
  CertifiedPendingSettlement = 2,
  Expired = 3,
  RejectedByThreshold = 4,
  Aborted = 5,
}

export function incidentAddress(covenant: PublicKey, incidentId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(incidentId);
  return PublicKey.findProgramAddressSync(
    [INCIDENT_SEED, covenant.toBuffer(), id],
    CORE_PROGRAM_ID,
  )[0];
}

export function claimAddress(core: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CLAIM_SEED, core.toBuffer()], CORE_PROGRAM_ID)[0];
}

export function attestationAddress(core: PublicKey, member: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ATTESTATION_SEED, core.toBuffer(), member.toBuffer()],
    CORE_PROGRAM_ID,
  )[0];
}

export function permissionAddress(account: PublicKey): PublicKey {
  return permissionPdaFromAccount(account);
}

/**
 * Permission visibility flags, as the permission program defines them.
 *
 * VINCT grants none of these. Membership is what lets a responder interact with a private
 * account; the flags only widen what that responder additionally sees of everyone else's
 * traffic, and an incident has no reason to hand that out.
 */
export const PERMISSION_FLAGS = {
  none: 0,
  authority: 1 << 0,
  txLogs: 1 << 1,
  txBalances: 1 << 2,
  txMessage: 1 << 3,
  accountSignatures: 1 << 4,
} as const;

export interface PermissionMember {
  pubkey: PublicKey;
  flags: number;
}

/** Minimum privilege: interaction only, no visibility into anyone else's traffic. */
export function interactionOnly(pubkey: PublicKey): PermissionMember {
  return { pubkey, flags: PERMISSION_FLAGS.none };
}

/**
 * Sorts members into the canonical order the program requires.
 *
 * Ascending by raw key bytes, strictly. The program rejects an out-of-order list rather than
 * sorting it, so that the commitment it computes is a function of the set and not of the
 * caller's arrangement. Sorting here means a caller never has to think about it, and the
 * program still catches anyone who skips this.
 */
export function canonicalMemberOrder(members: PublicKey[]): PublicKey[] {
  return [...members].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
}

// --------------------------------------------------------------- base layer

/**
 * Creates the public core, bound to a ratified covenant.
 *
 * The snapshot is copied out of the covenant rather than supplied: threshold, ceiling,
 * window, policy, epoch, and the frozen member set. The opener chooses none of it, which is
 * why they have to prove membership to open at all.
 */
export function initializeIncident(
  opener: PublicKey,
  covenant: PublicKey,
  incidentId: bigint,
): TransactionInstruction {
  const args = new ArgWriter().u64(incidentId).pubkey(covenant).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: incidentAddress(covenant, incidentId), isSigner: false, isWritable: true },
      { pubkey: covenant, isSigner: false, isWritable: false },
      {
        pubkey: covenantMemberAddress(covenant, opener),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: opener, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "initialize_incident"), args),
  });
}

export function initializeClaim(core: PublicKey, opener: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: claimAddress(core), isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "initialize_claim")),
  });
}

/**
 * Creates one member's attestation account.
 *
 * Called for every member before the incident opens, whether or not that member ever
 * responds. An account that appeared only when a member voted would announce that they had.
 */
export function initializeAttestation(
  core: PublicKey,
  covenant: PublicKey,
  opener: PublicKey,
  member: PublicKey,
): TransactionInstruction {
  const args = new ArgWriter().pubkey(member).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: covenantMemberAddress(covenant, member), isSigner: false, isWritable: false },
      { pubkey: attestationAddress(core, member), isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "initialize_attestation"), args),
  });
}

export interface DelegationAccounts {
  buffer: PublicKey;
  record: PublicKey;
  metadata: PublicKey;
  delegationProgram: PublicKey;
}

function delegationTail(
  delegated: PublicKey,
  validator: PublicKey | null,
  delegation: DelegationAccounts,
): AccountMeta[] {
  return [
    { pubkey: delegation.buffer, isSigner: false, isWritable: true },
    { pubkey: delegation.record, isSigner: false, isWritable: true },
    { pubkey: delegation.metadata, isSigner: false, isWritable: true },
    { pubkey: delegated, isSigner: false, isWritable: true },
    { pubkey: validator ?? CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: delegation.delegationProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

/**
 * Delegates the public core to a named validator.
 *
 * The validator is not really optional for this program. An incident's private accounts have
 * to land on a rollup that can keep them protected, and the router's default placement is
 * whichever region is nearest rather than whichever region attests.
 */
export function delegateIncident(
  opener: PublicKey,
  covenant: PublicKey,
  incidentId: bigint,
  validator: PublicKey | null,
  delegation: DelegationAccounts,
): TransactionInstruction {
  const core = incidentAddress(covenant, incidentId);
  const args = new ArgWriter().u64(incidentId).pubkey(covenant).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: opener, isSigner: true, isWritable: false },
      ...delegationTail(core, validator, delegation),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "delegate_incident"), args),
  });
}

export function delegateClaim(
  opener: PublicKey,
  core: PublicKey,
  validator: PublicKey | null,
  delegation: DelegationAccounts,
): TransactionInstruction {
  const args = new ArgWriter().pubkey(core).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: opener, isSigner: true, isWritable: false },
      ...delegationTail(claimAddress(core), validator, delegation),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "delegate_claim"), args),
  });
}

export function delegateAttestation(
  opener: PublicKey,
  core: PublicKey,
  member: PublicKey,
  validator: PublicKey | null,
  delegation: DelegationAccounts,
): TransactionInstruction {
  const args = new ArgWriter().pubkey(core).pubkey(member).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: opener, isSigner: true, isWritable: false },
      ...delegationTail(attestationAddress(core, member), validator, delegation),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "delegate_attestation"), args),
  });
}

// ---------------------------------------------------------- ephemeral rollup

function permissionTail(account: PublicKey): AccountMeta[] {
  return [
    { pubkey: permissionAddress(account), isSigner: false, isWritable: true },
    { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
    { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

function encodeMembers(members: PermissionMember[]): Buffer {
  const writer = new ArgWriter().u32(members.length);
  for (const member of members) writer.pubkey(member.pubkey).u8(member.flags);
  return writer.finish();
}

/** Makes the claim readable by the incident's members and nobody else. */
export function createClaimPermission(
  core: PublicKey,
  opener: PublicKey,
  members: PermissionMember[],
): TransactionInstruction {
  const claim = claimAddress(core);
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: claim, isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: false },
      ...permissionTail(claim),
    ],
    data: withDiscriminator(
      discriminator(CORE_IDL, "create_claim_permission"),
      encodeMembers(members),
    ),
  });
}

export function updateClaimPermission(
  core: PublicKey,
  opener: PublicKey,
  isPrivate: boolean,
  members: PermissionMember[],
): TransactionInstruction {
  const claim = claimAddress(core);
  const args = Buffer.concat([new ArgWriter().bool(isPrivate).finish(), encodeMembers(members)]);
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: claim, isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: false },
      ...permissionTail(claim),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "update_claim_permission"), args),
  });
}

/**
 * Closes the claim's permission. Permissionless, and gated on the scrub.
 *
 * Requiring the opener here would let a responder strand the evidence inside the rollup by
 * simply never calling it.
 */
export function closeClaimPermission(core: PublicKey): TransactionInstruction {
  const claim = claimAddress(core);
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [{ pubkey: claim, isSigner: false, isWritable: true }, ...permissionTail(claim)],
    data: withDiscriminator(discriminator(CORE_IDL, "close_claim_permission")),
  });
}

/**
 * Makes one attestation readable by its own member and nobody else.
 *
 * There is no member list parameter. The program reads the single member off the account, so
 * no caller can put a second reader on someone's ballot.
 */
export function createAttestationPermission(
  core: PublicKey,
  member: PublicKey,
): TransactionInstruction {
  const attestation = attestationAddress(core, member);
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: attestation, isSigner: false, isWritable: true },
      ...permissionTail(attestation),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "create_attestation_permission")),
  });
}

export function closeAttestationPermission(
  core: PublicKey,
  member: PublicKey,
): TransactionInstruction {
  const attestation = attestationAddress(core, member);
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: attestation, isSigner: false, isWritable: true },
      ...permissionTail(attestation),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "close_attestation_permission")),
  });
}

/**
 * Opens the incident.
 *
 * The terms are already frozen on the core, copied there from the covenant, so the only
 * argument is the digest of the claim. Every ballot account is passed in canonical order and
 * the program checks they are the covenant's set.
 */
export function openIncident(
  core: PublicKey,
  opener: PublicKey,
  members: PublicKey[],
  claimDigest: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: false },
      ...canonicalMemberOrder(members).map((member) => ({
        pubkey: attestationAddress(core, member),
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: withDiscriminator(
      discriminator(CORE_IDL, "open_incident"),
      new ArgWriter().bytes32(claimDigest).finish(),
    ),
  });
}

export interface PrivateClaimArgs {
  claim: Uint8Array;
  observationStart: bigint;
  observationEnd: bigint;
  notes: Uint8Array;
}

/**
 * Writes the raw claim.
 *
 * These bytes go into an ER transaction message and nowhere else. They must never be logged
 * by the caller, written to an artifact, or echoed to a console. The Phase 4 leak scan
 * treats any appearance of them outside the private runtime as a failure.
 */
export function submitPrivateClaim(
  core: PublicKey,
  responder: PublicKey,
  args: PrivateClaimArgs,
): TransactionInstruction {
  const data = Buffer.concat([
    new ArgWriter().u32(args.claim.length).finish(),
    Buffer.from(args.claim),
    new ArgWriter()
      .u64(BigInt.asUintN(64, args.observationStart))
      .u64(BigInt.asUintN(64, args.observationEnd))
      .u32(args.notes.length)
      .finish(),
    Buffer.from(args.notes),
  ]);
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: claimAddress(core), isSigner: false, isWritable: true },
      { pubkey: responder, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "submit_private_claim"), data),
  });
}

export function submitSealedAttestation(
  core: PublicKey,
  member: PublicKey,
  decision: Decision,
  submissionNonce: bigint,
): TransactionInstruction {
  const args = new ArgWriter().u8(decision).u64(submissionNonce).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: attestationAddress(core, member), isSigner: false, isWritable: true },
      { pubkey: member, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "submit_sealed_attestation"), args),
  });
}

export function quarantineMember(
  core: PublicKey,
  opener: PublicKey,
  member: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: attestationAddress(core, member), isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "quarantine_member")),
  });
}

/**
 * Counts every attestation at once.
 *
 * All of them are passed, including members who never responded, because there is nowhere
 * for a partial count to live. That is also what keeps k-of-n liveness: a silent member's
 * account exists and contributes nothing, so certification never waits on them.
 */
export function certifyIncident(core: PublicKey, members: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: true },
      ...canonicalMemberOrder(members).map((member) => ({
        pubkey: attestationAddress(core, member),
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "certify_incident")),
  });
}

/**
 * This incident's scheduler task ID, derived the way the program derives it.
 *
 * A task ID is global to a scheduler instance and is not part of any key, so a counter would
 * eventually collide with whatever else is scheduling on the same validator. Both sides
 * compute the same domain-separated digest, and the parity is asserted in
 * `tests/program/crank-monitor.test.ts` rather than assumed.
 */
export function expiryTaskId(core: IncidentCoreView): bigint {
  const preimage = Buffer.concat([
    Buffer.from("vinct:expiry-task:v1", "utf8"),
    Buffer.from(core.clusterGenesisHash),
    core.covenant.toBuffer(),
    (() => {
      const out = Buffer.alloc(8);
      out.writeBigUInt64LE(core.incidentId);
      return out;
    })(),
  ]);
  const digest = sha256Bytes(preimage);
  // The program clears the sign bit rather than negating: `i64::MIN` has no positive
  // counterpart, so negation would have one input with no valid output.
  return digest.readBigInt64LE(0) & 0x7fffffffffffffffn;
}

/**
 * Asks the scheduler to run `expire_incident` on a cadence.
 *
 * The instruction the task will execute is built inside the program, not here. This carries
 * the cadence and the ballot set, and the program decides what gets scheduled.
 *
 * The returned signature means the request was accepted. Registration and execution are
 * separate observations; see `packages/monitor/src/crank.ts`.
 */
export function requestExpiryCrank(
  core: PublicKey,
  opener: PublicKey,
  members: PublicKey[],
  executionIntervalMillis: bigint,
  iterations: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      // Writable because the magic program takes the task context account writable, and a CPI
      // cannot escalate a privilege the outer instruction does not hold.
      { pubkey: core, isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      ...canonicalMemberOrder(members).map((member) => ({
        pubkey: attestationAddress(core, member),
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: withDiscriminator(
      discriminator(CORE_IDL, "request_expiry_crank"),
      new ArgWriter().i64(executionIntervalMillis).i64(iterations).finish(),
    ),
  });
}

/** Asks the scheduler to remove this incident's expiry task. Opener only. */
export function cancelExpiryCrank(core: PublicKey, opener: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "cancel_expiry_crank")),
  });
}

/**
 * The scheduled terminal handler, callable by hand.
 *
 * The manual fallback the PRD requires. A scheduler that does not guarantee wall-clock timing
 * cannot be the only way an incident reaches a terminal state, so the same instruction the
 * task runs is available to anyone. It is permissionless and carries no signer, because the
 * scheduled version has none either.
 */
export function expireIncident(core: PublicKey, members: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: true },
      ...canonicalMemberOrder(members).map((member) => ({
        pubkey: attestationAddress(core, member),
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "expire_incident")),
  });
}

export function scrubClaim(core: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: claimAddress(core), isSigner: false, isWritable: true },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "scrub_claim")),
  });
}

export function scrubAttestation(core: PublicKey, member: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: attestationAddress(core, member), isSigner: false, isWritable: true },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "scrub_attestation")),
  });
}

function exitKeys(payer: PublicKey, core: PublicKey, members: PublicKey[]): AccountMeta[] {
  return [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: core, isSigner: false, isWritable: true },
    { pubkey: claimAddress(core), isSigner: false, isWritable: true },
    // `#[commit]` appends magic_program first, then magic_context.
    { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ...canonicalMemberOrder(members).map((member) => ({
      pubkey: attestationAddress(core, member),
      isSigner: false,
      isWritable: true,
    })),
  ];
}

export function commitIncident(
  payer: PublicKey,
  covenant: PublicKey,
  incidentId: bigint,
  members: PublicKey[],
): TransactionInstruction {
  const core = incidentAddress(covenant, incidentId);
  const args = new ArgWriter().u64(incidentId).pubkey(covenant).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: exitKeys(payer, core, members),
    data: withDiscriminator(discriminator(CORE_IDL, "commit_incident"), args),
  });
}

export function releaseIncident(
  payer: PublicKey,
  covenant: PublicKey,
  incidentId: bigint,
  members: PublicKey[],
): TransactionInstruction {
  const core = incidentAddress(covenant, incidentId);
  const args = new ArgWriter().u64(incidentId).pubkey(covenant).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: exitKeys(payer, core, members),
    data: withDiscriminator(discriminator(CORE_IDL, "release_incident"), args),
  });
}

// ------------------------------------------------------------------ decoding

/**
 * The public incident core.
 *
 * Everything here is readable by anyone, which is the point of the account. There is
 * deliberately no decoder in this module for the claim or for an attestation: a client that
 * needed one would be a client reading someone's private state.
 */
export interface IncidentCoreView {
  version: number;
  covenant: PublicKey;
  circleEpoch: bigint;
  incidentId: bigint;
  opener: PublicKey;
  status: IncidentStatus;
  policyId: Uint8Array;
  memberSetHash: Uint8Array;
  clusterGenesisHash: Uint8Array;
  requiredApprovals: number;
  maximumRejections: number;
  openedAtSlot: bigint;
  expiresAtSlot: bigint;
  responseWindowSlots: bigint;
  actionBundleTemplateHash: Uint8Array;
  claimDigest: Uint8Array;
  operationId: Uint8Array;
  certifiedAtSlot: bigint;
  certificateLifetimeSlots: bigint;
  memberCount: number;
  approvalCountAfterTerminal: number;
  rejectionCountAfterTerminal: number;
}

/**
 * Decodes the public core.
 *
 * Field order mirrors `vinct_core::incident::IncidentCore` exactly. A decoder that drifts
 * from the account it reads produces plausible-looking nonsense rather than an error, which
 * is why `the_client_decodes_the_core_the_program_wrote` exists.
 */
export function decodeIncidentCore(data: Buffer): IncidentCoreView {
  expectAccount(
    data,
    "IncidentCore",
    8 +
      2 +
      32 +
      8 +
      8 +
      32 +
      1 +
      32 +
      32 +
      32 +
      1 +
      1 +
      8 +
      8 +
      8 +
      32 +
      32 +
      32 +
      8 +
      8 +
      1 +
      1 +
      1 +
      1,
  );
  const body = data.subarray(8);
  let offset = 0;
  const pubkey = (): PublicKey => {
    const value = new PublicKey(body.subarray(offset, offset + 32));
    offset += 32;
    return value;
  };
  const bytes32 = (): Uint8Array => {
    const value = new Uint8Array(body.subarray(offset, offset + 32));
    offset += 32;
    return value;
  };
  const u64 = (): bigint => {
    const value = body.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };
  const u16 = (): number => {
    const value = body.readUInt16LE(offset);
    offset += 2;
    return value;
  };
  const u8 = (): number => body[offset++] ?? 0;

  return {
    version: expectVersion("IncidentCore", u16()),
    covenant: pubkey(),
    circleEpoch: u64(),
    incidentId: u64(),
    opener: pubkey(),
    status: u8() as IncidentStatus,
    policyId: bytes32(),
    memberSetHash: bytes32(),
    clusterGenesisHash: bytes32(),
    requiredApprovals: u8(),
    maximumRejections: u8(),
    openedAtSlot: u64(),
    expiresAtSlot: u64(),
    responseWindowSlots: u64(),
    actionBundleTemplateHash: bytes32(),
    claimDigest: bytes32(),
    operationId: bytes32(),
    certifiedAtSlot: u64(),
    certificateLifetimeSlots: u64(),
    memberCount: u8(),
    approvalCountAfterTerminal: u8(),
    rejectionCountAfterTerminal: u8(),
  };
}

/**
 * What a client may learn from a private account without reading anyone's secret.
 *
 * Deliberately not a decoder for the contents. These two accounts hold the claim and the
 * ballots, and a client that decoded those would be a client reading private state. What a
 * verifier legitimately needs is the opposite question: whether the protected region is
 * actually zero once the incident is terminal, which is a property of the bytes rather than
 * of what they used to say.
 */
export interface ScrubbedAccountView {
  version: number;
  incident: PublicKey;
  /** Whether the program marked it scrubbed. Never trusted on its own. */
  privateFieldsZeroized: boolean;
  /** Whether every byte of the protected region is actually zero. */
  protectedRegionAllZero: boolean;
}

/**
 * Reads a claim account's public shell and checks its protected region is zero.
 *
 * The claim's bytes are never returned. If the region is not zero, that is reported as a
 * boolean and the contents stay where they are.
 */
export function decodeIncidentClaim(data: Buffer): ScrubbedAccountView & { opener: PublicKey } {
  const size = 8 + 2 + 32 + 32 + 256 + 2 + 128 + 2 + 8 + 8 + 1 + 1;
  expectAccount(data, "IncidentClaim", size);
  const body = data.subarray(8);
  const version = expectVersion("IncidentClaim", body.readUInt16LE(0));
  const protectedStart = CLAIM_PROTECTED_REGION.offset - 8;
  const protectedEnd = protectedStart + CLAIM_PROTECTED_REGION.length;
  return {
    version,
    incident: new PublicKey(body.subarray(2, 34)),
    opener: new PublicKey(body.subarray(34, 66)),
    privateFieldsZeroized: body[protectedEnd] === 1,
    protectedRegionAllZero: body.subarray(protectedStart, protectedEnd).every((byte) => byte === 0),
  };
}

/** The same for one member's ballot. Its decision is never returned. */
export function decodeMemberAttestation(
  data: Buffer,
): ScrubbedAccountView & { member: PublicKey; opener: PublicKey; state: number } {
  const size = 8 + 2 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 1;
  expectAccount(data, "MemberAttestation", size);
  const body = data.subarray(8);
  const version = expectVersion("MemberAttestation", body.readUInt16LE(0));
  const protectedStart = ATTESTATION_PROTECTED_REGION.offset - 8;
  const protectedEnd = protectedStart + ATTESTATION_PROTECTED_REGION.length;
  return {
    version,
    incident: new PublicKey(body.subarray(2, 34)),
    member: new PublicKey(body.subarray(34, 66)),
    opener: new PublicKey(body.subarray(66, 98)),
    state: body[98] ?? 0,
    privateFieldsZeroized: body[protectedEnd] === 1,
    protectedRegionAllZero: body.subarray(protectedStart, protectedEnd).every((byte) => byte === 0),
  };
}

/** The schema version this client speaks. Mirrors `vinct_core::incident`. */
export const INCIDENT_SCHEMA_VERSION = 1;

/** Where the protected region sits in a claim account, for the leak scan. */
export const CLAIM_PROTECTED_REGION = {
  offset: 8 + 2 + 32 + 32,
  length: 256 + 2 + 128 + 2 + 8 + 8,
} as const;

/** Where the protected region sits in an attestation account, for the leak scan. */
export const ATTESTATION_PROTECTED_REGION = {
  offset: 8 + 2 + 32 + 32 + 32 + 1,
  length: 1 + 8 + 8 + 1,
} as const;

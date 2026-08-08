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

import { ArgWriter, withDiscriminator } from "./encoding.js";
import { CORE_IDL, CORE_PROGRAM_ID, discriminator } from "./ids.js";

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

// --------------------------------------------------------------- base layer

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
  opener: PublicKey,
  member: PublicKey,
): TransactionInstruction {
  const args = new ArgWriter().pubkey(member).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: false },
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

export interface OpenIncidentArgs {
  covenant: PublicKey;
  incidentId: bigint;
  circleEpoch: bigint;
  policyId: Uint8Array;
  clusterGenesisHash: Uint8Array;
  requiredApprovals: number;
  maximumRejections: number;
  responseWindowSlots: bigint;
  /** Every member eligible to attest. Sorted here; the program refuses an unsorted list. */
  members: PublicKey[];
  claimDigest: Uint8Array;
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

/**
 * Opens the incident and freezes its member set.
 *
 * Every member's ballot account is passed after the declared accounts. The program checks
 * each one exists at its canonical address before committing to the set, because freezing a
 * set with a missing ballot would make certification impossible for the incident's whole life.
 */
export function openIncident(opener: PublicKey, args: OpenIncidentArgs): TransactionInstruction {
  const members = canonicalMemberOrder(args.members);
  const core = incidentAddress(args.covenant, args.incidentId);

  const writer = new ArgWriter()
    .u64(args.incidentId)
    .pubkey(args.covenant)
    .u64(args.circleEpoch)
    .bytes32(args.policyId)
    .bytes32(args.clusterGenesisHash)
    .u8(args.requiredApprovals)
    .u8(args.maximumRejections)
    .u64(args.responseWindowSlots)
    .u32(members.length);
  for (const member of members) writer.pubkey(member);
  writer.bytes32(args.claimDigest);

  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: core, isSigner: false, isWritable: true },
      { pubkey: opener, isSigner: true, isWritable: false },
      ...members.map((member) => ({
        pubkey: attestationAddress(core, member),
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "open_incident"), writer.finish()),
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
  claimDigest: Uint8Array;
  operationId: Uint8Array;
  memberCount: number;
  approvalCountAfterTerminal: number;
  rejectionCountAfterTerminal: number;
}

export function decodeIncidentCore(data: Buffer): IncidentCoreView {
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
  const u8 = (): number => body[offset++] ?? 0;
  const u16 = (): number => {
    const value = body.readUInt16LE(offset);
    offset += 2;
    return value;
  };

  return {
    version: u16(),
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
    claimDigest: bytes32(),
    operationId: bytes32(),
    memberCount: u8(),
    approvalCountAfterTerminal: u8(),
    rejectionCountAfterTerminal: u8(),
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

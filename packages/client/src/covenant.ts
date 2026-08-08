/**
 * Covenant formation, client side.
 *
 * The sequence matters more than any single call. The steward convenes and adds members and
 * can do nothing else; each protocol ratifies and arms its own membership; the two
 * covenant-level steps take no signer at all, because by then every signature that mattered
 * has been given. A helper that collapsed this into one call would be hiding the property
 * the design exists for.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import {
  expectAccount as expectCovenantAccount,
  expectVersion as expectCovenantVersion,
} from "./accounts.js";

import { ArgWriter, withDiscriminator } from "./encoding.js";
import { CORE_IDL, CORE_PROGRAM_ID, discriminator } from "./ids.js";
import { canonicalMemberOrder } from "./incident.js";

export const COVENANT_SEED = Buffer.from("covenant");
export const COVENANT_MEMBER_SEED = Buffer.from("member");

/** Mirrors `vinct_core::covenant::MemberRole`. Borsh enum indices. */
export enum MemberRole {
  Protocol = 0,
  Responder = 1,
  Steward = 2,
}

/** Mirrors `vinct_core::covenant::CovenantStatus`. */
export enum CovenantStatus {
  Draft = 0,
  Ratified = 1,
  Armed = 2,
  Suspended = 3,
  Expired = 4,
  Superseded = 5,
}

export function covenantAddress(steward: PublicKey, covenantId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(covenantId);
  return PublicKey.findProgramAddressSync(
    [COVENANT_SEED, steward.toBuffer(), id],
    CORE_PROGRAM_ID,
  )[0];
}

export function covenantMemberAddress(covenant: PublicKey, protocol: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [COVENANT_MEMBER_SEED, covenant.toBuffer(), protocol.toBuffer()],
    CORE_PROGRAM_ID,
  )[0];
}

export interface CreateCovenantArgs {
  covenantId: bigint;
  circleEpoch: bigint;
  clusterGenesisHash: Uint8Array;
  policyId: Uint8Array;
  /** The action template the policy commits to. Feeds the operation ID. */
  actionBundleTemplateHash: Uint8Array;
  requiredApprovals: number;
  maximumRejections: number;
  responseWindowSlots: bigint;
  certificateLifetimeSlots: bigint;
  epochLifetimeSlots: bigint;
}

export function createCovenant(
  steward: PublicKey,
  args: CreateCovenantArgs,
): TransactionInstruction {
  const data = new ArgWriter()
    .u64(args.covenantId)
    .u64(args.circleEpoch)
    .bytes32(args.clusterGenesisHash)
    .bytes32(args.policyId)
    .bytes32(args.actionBundleTemplateHash)
    .u8(args.requiredApprovals)
    .u8(args.maximumRejections)
    .u64(args.responseWindowSlots)
    .u64(args.certificateLifetimeSlots)
    .u64(args.epochLifetimeSlots)
    .finish();

  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: covenantAddress(steward, args.covenantId), isSigner: false, isWritable: true },
      { pubkey: steward, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "create_covenant"), data),
  });
}

export function addCovenantMember(
  covenant: PublicKey,
  steward: PublicKey,
  protocol: PublicKey,
  role: MemberRole,
  adapterCapability: PublicKey,
): TransactionInstruction {
  const data = new ArgWriter().pubkey(protocol).u8(role).pubkey(adapterCapability).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: covenant, isSigner: false, isWritable: true },
      { pubkey: covenantMemberAddress(covenant, protocol), isSigner: false, isWritable: true },
      { pubkey: steward, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "add_covenant_member"), data),
  });
}

/** The protocol's own signature. Nobody can produce this for them, which is the point. */
export function ratifyCovenantMember(
  covenant: PublicKey,
  protocol: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: covenant, isSigner: false, isWritable: true },
      { pubkey: covenantMemberAddress(covenant, protocol), isSigner: false, isWritable: true },
      { pubkey: protocol, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "ratify_covenant_member")),
  });
}

export function armCovenantMember(
  covenant: PublicKey,
  protocol: PublicKey,
  adapterVersion: number,
): TransactionInstruction {
  const data = new ArgWriter().u16(adapterVersion).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: covenant, isSigner: false, isWritable: true },
      { pubkey: covenantMemberAddress(covenant, protocol), isSigner: false, isWritable: true },
      { pubkey: protocol, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "arm_covenant_member"), data),
  });
}

/**
 * Freezes the member set.
 *
 * Every membership account is passed, strictly ascending by protocol authority, and the
 * program computes the commitment over them. Permissionless: every signature that mattered
 * was collected already, and requiring one more would let whoever held it stall a circle
 * that had agreed.
 */
export function ratifyCovenant(covenant: PublicKey, members: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: covenant, isSigner: false, isWritable: true },
      ...canonicalMemberOrder(members).map((protocol) => ({
        pubkey: covenantMemberAddress(covenant, protocol),
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "ratify_covenant")),
  });
}

export function armCovenant(covenant: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [{ pubkey: covenant, isSigner: false, isWritable: true }],
    data: withDiscriminator(discriminator(CORE_IDL, "arm_covenant")),
  });
}

/** One protocol's membership. Public, like everything else about a covenant. */
export interface CovenantMemberView {
  version: number;
  covenant: PublicKey;
  protocol: PublicKey;
  role: MemberRole;
  adapterCapability: PublicKey;
  adapterVersion: number;
  ratified: boolean;
  armed: boolean;
}

export function decodeCovenantMember(data: Buffer): CovenantMemberView {
  expectCovenantAccount(data, "CovenantMember", 8 + 2 + 32 + 32 + 1 + 32 + 2 + 1 + 1 + 1);
  const body = data.subarray(8);
  let offset = 0;
  const u16 = (): number => {
    const value = body.readUInt16LE(offset);
    offset += 2;
    return value;
  };
  const pubkey = (): PublicKey => {
    const value = new PublicKey(body.subarray(offset, offset + 32));
    offset += 32;
    return value;
  };
  const u8 = (): number => body[offset++] ?? 0;

  return {
    version: expectCovenantVersion("CovenantMember", u16()),
    covenant: pubkey(),
    protocol: pubkey(),
    role: u8() as MemberRole,
    adapterCapability: pubkey(),
    adapterVersion: u16(),
    ratified: u8() === 1,
    armed: u8() === 1,
  };
}

/** The public covenant. Everything here is readable by anyone, by design. */
export interface CovenantView {
  version: number;
  steward: PublicKey;
  covenantId: bigint;
  circleEpoch: bigint;
  clusterGenesisHash: Uint8Array;
  status: CovenantStatus;
  policyId: Uint8Array;
  /** The action template the policy commits to. Feeds the operation ID. */
  actionBundleTemplateHash: Uint8Array;
  requiredApprovals: number;
  maximumRejections: number;
  responseWindowSlots: bigint;
  certificateLifetimeSlots: bigint;
  memberCount: number;
  ratifiedCount: number;
  armedCount: number;
  adapterCount: number;
  memberSetHash: Uint8Array;
  validFromSlot: bigint;
  expiresAtSlot: bigint;
}

export function decodeCovenant(data: Buffer): CovenantView {
  expectCovenantAccount(
    data,
    "Covenant",
    8 + 2 + 32 + 8 + 8 + 32 + 1 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 1 + 1 + 32 + 8 + 8 + 1,
  );
  const body = data.subarray(8);
  let offset = 0;
  const u16 = (): number => {
    const value = body.readUInt16LE(offset);
    offset += 2;
    return value;
  };
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

  return {
    version: expectCovenantVersion("Covenant", u16()),
    steward: pubkey(),
    covenantId: u64(),
    circleEpoch: u64(),
    clusterGenesisHash: bytes32(),
    status: u8() as CovenantStatus,
    policyId: bytes32(),
    actionBundleTemplateHash: bytes32(),
    requiredApprovals: u8(),
    maximumRejections: u8(),
    responseWindowSlots: u64(),
    certificateLifetimeSlots: u64(),
    memberCount: u8(),
    ratifiedCount: u8(),
    armedCount: u8(),
    adapterCount: u8(),
    memberSetHash: bytes32(),
    validFromSlot: u64(),
    expiresAtSlot: u64(),
  };
}

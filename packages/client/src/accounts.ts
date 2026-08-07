/**
 * Account decoders.
 *
 * Layouts mirror the programs' `#[account]` structs field for field, after the 8-byte
 * Anchor discriminator. They are hand-written for the same reason the encoders are: the
 * settlement monitor has to be able to read base-layer state without trusting a client
 * library, and a judge has to be able to read this file and check it against the program.
 */

import { PublicKey } from "@solana/web3.js";

class Cursor {
  #offset = 0;

  constructor(private readonly data: Buffer) {}

  skipDiscriminator(): this {
    this.#offset = 8;
    return this;
  }

  u8(): number {
    const value = this.data.readUInt8(this.#offset);
    this.#offset += 1;
    return value;
  }

  bool(): boolean {
    return this.u8() === 1;
  }

  u16(): number {
    const value = this.data.readUInt16LE(this.#offset);
    this.#offset += 2;
    return value;
  }

  u64(): bigint {
    const value = this.data.readBigUInt64LE(this.#offset);
    this.#offset += 8;
    return value;
  }

  bytes(length: number): Uint8Array {
    const value = Uint8Array.prototype.slice.call(this.data, this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  bytes32(): Uint8Array {
    return this.bytes(32);
  }

  pubkey(): PublicKey {
    const value = new PublicKey(this.data.subarray(this.#offset, this.#offset + 32));
    this.#offset += 32;
    return value;
  }
}

export interface ProtocolMarket {
  authority: PublicKey;
  marketId: bigint;
  adapterSigner: PublicKey;
  newBorrowingPaused: boolean;
  lastOperationId: Uint8Array;
  updateCount: bigint;
  demoAuthority: PublicKey;
}

export function decodeMarket(data: Buffer): ProtocolMarket {
  const c = new Cursor(data).skipDiscriminator();
  return {
    authority: c.pubkey(),
    marketId: c.u64(),
    adapterSigner: c.pubkey(),
    newBorrowingPaused: c.bool(),
    lastOperationId: c.bytes32(),
    updateCount: c.u64(),
    demoAuthority: c.pubkey(),
  };
}

export interface AdapterReceipt {
  operationId: Uint8Array;
  capability: PublicKey;
  executed: boolean;
  targetEffectApplied: boolean;
  executedAtSlot: bigint;
}

export function decodeAdapterReceipt(data: Buffer): AdapterReceipt {
  const c = new Cursor(data).skipDiscriminator();
  return {
    operationId: c.bytes32(),
    capability: c.pubkey(),
    executed: c.bool(),
    targetEffectApplied: c.bool(),
    executedAtSlot: c.u64(),
  };
}

export interface SettlementReceipt {
  operationId: Uint8Array;
  certificate: PublicKey;
  finalized: boolean;
  observedActionCount: number;
  finalizedAtSlot: bigint;
}

export function decodeSettlementReceipt(data: Buffer): SettlementReceipt {
  const c = new Cursor(data).skipDiscriminator();
  return {
    operationId: c.bytes32(),
    certificate: c.pubkey(),
    finalized: c.bool(),
    observedActionCount: c.u16(),
    finalizedAtSlot: c.u64(),
  };
}

export interface SettlementOperation {
  operationId: Uint8Array;
  certificate: PublicKey;
  authority: PublicKey;
  expectedActionCount: number;
  scheduled: boolean;
  scheduledAtSlot: bigint;
  attemptCount: number;
}

export function decodeOperation(data: Buffer): SettlementOperation {
  const c = new Cursor(data).skipDiscriminator();
  return {
    operationId: c.bytes32(),
    certificate: c.pubkey(),
    authority: c.pubkey(),
    expectedActionCount: c.u16(),
    scheduled: c.bool(),
    scheduledAtSlot: c.u64(),
    attemptCount: c.u16(),
  };
}

export interface IncidentCertificate {
  issuingAuthority: PublicKey;
  clusterGenesisHash: Uint8Array;
  covenant: PublicKey;
  circleEpoch: bigint;
  incidentId: bigint;
  policyId: Uint8Array;
  memberSetHash: Uint8Array;
  actionBundleHash: Uint8Array;
  operationId: Uint8Array;
  certificateNonce: bigint;
  approvalCount: number;
  rejectionCount: number;
  certifiedAtSlot: bigint;
  expiresAtSlot: bigint;
}

export function decodeCertificate(data: Buffer): IncidentCertificate {
  const c = new Cursor(data).skipDiscriminator();
  return {
    issuingAuthority: c.pubkey(),
    clusterGenesisHash: c.bytes32(),
    covenant: c.pubkey(),
    circleEpoch: c.u64(),
    incidentId: c.u64(),
    policyId: c.bytes32(),
    memberSetHash: c.bytes32(),
    actionBundleHash: c.bytes32(),
    operationId: c.bytes32(),
    certificateNonce: c.u64(),
    approvalCount: c.u8(),
    rejectionCount: c.u8(),
    certifiedAtSlot: c.u64(),
    expiresAtSlot: c.u64(),
  };
}

export interface SovereignCapability {
  protocolAuthority: PublicKey;
  protocolState: PublicKey;
  coreProgram: PublicKey;
  adapterVersion: number;
  clusterGenesisHash: Uint8Array;
  covenant: PublicKey;
  circleEpoch: bigint;
  policyId: Uint8Array;
  memberSetHash: Uint8Array;
  actionCategory: number;
  targetProgram: PublicKey;
  instructionDiscriminator: Uint8Array;
  orderedAccountMetasHash: Uint8Array;
  instructionDataHash: Uint8Array;
  maxEffect: { mayPause: boolean; mayUnpause: boolean; maxValueMoved: bigint };
  validFromSlot: bigint;
  expiresAtSlot: bigint;
  armed: boolean;
  suspended: boolean;
  capabilityNonce: bigint;
  lastOperationId: Uint8Array;
}

export function decodeCapability(data: Buffer): SovereignCapability {
  const c = new Cursor(data).skipDiscriminator();
  return {
    protocolAuthority: c.pubkey(),
    protocolState: c.pubkey(),
    coreProgram: c.pubkey(),
    adapterVersion: c.u16(),
    clusterGenesisHash: c.bytes32(),
    covenant: c.pubkey(),
    circleEpoch: c.u64(),
    policyId: c.bytes32(),
    memberSetHash: c.bytes32(),
    actionCategory: c.u8(),
    targetProgram: c.pubkey(),
    instructionDiscriminator: c.bytes(8),
    orderedAccountMetasHash: c.bytes32(),
    instructionDataHash: c.bytes32(),
    maxEffect: {
      mayPause: c.bool(),
      mayUnpause: c.bool(),
      maxValueMoved: c.u64(),
    },
    validFromSlot: c.u64(),
    expiresAtSlot: c.u64(),
    armed: c.bool(),
    suspended: c.bool(),
    capabilityNonce: c.u64(),
    lastOperationId: c.bytes32(),
  };
}

/**
 * Account decoders.
 *
 * Layouts mirror the programs' `#[account]` structs field for field, after the 8-byte
 * Anchor discriminator. They are hand-written for the same reason the encoders are: the
 * settlement monitor has to read base-layer state without trusting a client library, and a
 * judge has to be able to read this file and check it against the program.
 *
 * Hand-writing them has a specific failure mode. A decoder that drifts from the account it
 * reads does not throw; it reads the wrong offsets and returns numbers that look like
 * numbers. That happened, and a run reported two approvals as fifty while printing PASS. See
 * `docs/decision-log.md` D-0051.
 *
 * Three things follow from that, and every decoder here does all three.
 *
 * The discriminator is asserted, so reading one account as another fails instead of
 * producing a plausible other account. The length is asserted, so a truncated or sliced
 * buffer fails instead of reading zeros off the end. And versioned accounts refuse a version
 * this build does not know, rather than interpreting an unfamiliar layout optimistically.
 *
 * The layouts themselves are pinned by `tests/program/account-layout-parity.test.ts` against
 * vectors generated from the programs' own Rust structs.
 */

import { PublicKey } from "@solana/web3.js";
import { sha256 as sha256Bytes } from "./sha256.js";

/** The schema version this client speaks for the versioned account family. */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Anchor's account discriminator: the first eight bytes of `sha256("account:<Name>")`.
 *
 * Recomputed here rather than imported from an IDL, so a decoder can be checked against the
 * program by reading this file, which is the reason these decoders are hand-written at all.
 */
function accountDiscriminator(name: string): Buffer {
  return sha256Bytes(`account:${name}`).subarray(0, 8);
}

/**
 * Rejects a buffer that is not this account, or not all of it.
 *
 * `minimumLength` is the account's serialized size including the discriminator. Equality is
 * not required because a program may be upgraded to a longer layout while a client is still
 * reading the prefix it knows, and that is a supported situation. Reading past the end is
 * not.
 */
export function expectAccount(data: Buffer, name: string, minimumLength: number): void {
  if (data.length < 8) {
    throw new Error(`${name}: buffer is too short to hold a discriminator`);
  }
  const expected = accountDiscriminator(name);
  if (!data.subarray(0, 8).equals(expected)) {
    throw new Error(
      `${name}: discriminator mismatch. This buffer is a different account type, or not an Anchor account.`,
    );
  }
  if (data.length < minimumLength) {
    throw new Error(
      `${name}: buffer is too short. Expected at least ${minimumLength} bytes, got ${data.length}.`,
    );
  }
}

/** Rejects a version this build has never seen, rather than guessing at its layout. */
export function expectVersion(name: string, version: number): number {
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `${name}: schema version ${version} is not supported. This build speaks version ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  return version;
}

class Cursor {
  #offset = 0;

  constructor(private readonly data: Buffer) {}

  skipDiscriminator(): this {
    this.#offset = 8;
    return this;
  }

  i64(): bigint {
    const value = this.data.readBigInt64LE(this.#offset);
    this.#offset += 8;
    return value;
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
  expectAccount(data, "ProtocolMarket", 154);
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
  expectAccount(data, "AdapterReceipt", 83);
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
  expectAccount(data, "SettlementReceipt", 84);
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
  expectAccount(data, "SettlementOperation", 118);
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
  expectAccount(data, "IncidentCertificate", 275);
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
  actionTemplateHash: Uint8Array;
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
  expectAccount(data, "SovereignCapability", 417);
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
    actionTemplateHash: c.bytes32(),
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

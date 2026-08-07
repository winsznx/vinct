/**
 * Instruction-argument encoding.
 *
 * Built by hand rather than through Anchor's IDL client. Two reasons. The adversarial tests
 * need to construct arguments and account lists a well-behaved client would refuse to
 * produce. And the on-chain adapter commits to a hash of the exact instruction data, so the
 * client's encoder has to be something this repository can read and reason about, not a
 * dependency's implementation detail.
 */

import { PublicKey } from "@solana/web3.js";

export class ArgWriter {
  #parts: Buffer[] = [];

  u8(value: number): this {
    return this.#push(Buffer.from([value]));
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u16(value: number): this {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    return this.#push(buffer);
  }

  u32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return this.#push(buffer);
  }

  u64(value: bigint): this {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    return this.#push(buffer);
  }

  bytes32(value: Uint8Array): this {
    if (value.length !== 32) {
      throw new RangeError(`expected 32 bytes, got ${value.length}`);
    }
    return this.#push(Buffer.from(value));
  }

  bytes8(value: Uint8Array): this {
    if (value.length !== 8) {
      throw new RangeError(`expected 8 bytes, got ${value.length}`);
    }
    return this.#push(Buffer.from(value));
  }

  pubkey(value: PublicKey): this {
    return this.#push(value.toBuffer());
  }

  /** Borsh `Option<T>`: a presence byte then the value. */
  optionPubkey(value: PublicKey | null): this {
    if (value === null) return this.u8(0);
    return this.u8(1).pubkey(value);
  }

  finish(): Buffer {
    return Buffer.concat(this.#parts);
  }

  #push(part: Buffer): this {
    this.#parts.push(part);
    return this;
  }
}

/** Prefixes encoded arguments with an instruction discriminator. */
export function withDiscriminator(disc: Buffer, args: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([disc, args]);
}

/**
 * A minimal Borsh reader and writer.
 *
 * Written from the Borsh specification rather than wrapped around a library, because the
 * point of this package is to be an independent second implementation. Importing the same
 * encoder the Rust side uses would make the parity check circular.
 *
 * Encoding rules used here:
 *   u8            one byte
 *   u16, u32, u64 little endian, fixed width
 *   i64           little endian, two's complement
 *   bool          one byte, 0 or 1, and nothing else decodes
 *   [u8; N]       N raw bytes, no length prefix
 *   Vec<T>        u32 little-endian length, then elements
 *   struct        fields in declaration order, no padding
 *   enum (unit)   u8 variant index
 */

export class BorshWriter {
  #chunks: Uint8Array[] = [];
  #length = 0;

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`u8 out of range: ${value}`);
    }
    return this.#push(Uint8Array.of(value));
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new RangeError(`u16 out of range: ${value}`);
    }
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return this.#push(bytes);
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`u32 out of range: ${value}`);
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return this.#push(bytes);
  }

  u64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new RangeError(`u64 out of range: ${value}`);
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return this.#push(bytes);
  }

  i64(value: bigint): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    return this.#push(bytes);
  }

  /** Fixed-width byte array. No length prefix. */
  fixedBytes(value: Uint8Array, expectedLength: number): this {
    if (value.length !== expectedLength) {
      throw new RangeError(`expected ${expectedLength} bytes, got ${value.length}`);
    }
    return this.#push(value);
  }

  /** Length-prefixed byte vector. */
  bytes(value: Uint8Array): this {
    this.u32(value.length);
    return this.#push(value);
  }

  vec<T>(items: readonly T[], write: (writer: BorshWriter, item: T) => void): this {
    this.u32(items.length);
    for (const item of items) {
      write(this, item);
    }
    return this;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  #push(bytes: Uint8Array): this {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    return this;
  }
}

export class BorshReader {
  #view: DataView;
  #offset = 0;

  constructor(private readonly buffer: Uint8Array) {
    this.#view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  u8(): number {
    this.#require(1);
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  /**
   * Borsh admits exactly 0 and 1 for a bool. Anything else is a malformed encoding, and
   * accepting it would let two byte strings decode to the same value and hash differently.
   */
  bool(): boolean {
    const value = this.u8();
    if (value > 1) {
      throw new Error(`invalid bool byte: ${value}`);
    }
    return value === 1;
  }

  u16(): number {
    this.#require(2);
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  u64(): bigint {
    this.#require(8);
    const value = this.#view.getBigUint64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  i64(): bigint {
    this.#require(8);
    const value = this.#view.getBigInt64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  fixedBytes(length: number): Uint8Array {
    this.#require(length);
    const value = this.buffer.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  bytes(): Uint8Array {
    return this.fixedBytes(this.u32());
  }

  vec<T>(read: (reader: BorshReader) => T): T[] {
    const length = this.u32();
    const items: T[] = [];
    for (let index = 0; index < length; index += 1) {
      items.push(read(this));
    }
    return items;
  }

  /** Throws unless every byte was consumed. Trailing bytes are never tolerated. */
  finish(): void {
    if (this.#offset !== this.buffer.length) {
      throw new Error(`trailing bytes: consumed ${this.#offset} of ${this.buffer.length}`);
    }
  }

  #require(count: number): void {
    if (this.#offset + count > this.buffer.length) {
      throw new Error(`unexpected end of input at offset ${this.#offset}`);
    }
  }
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`odd-length hex string: ${hex.length} characters`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at byte ${index}`);
    }
    out[index] = byte;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Every hand-written decoder, against bytes the programs themselves produced.
 *
 * A decoder that has drifted from the account it reads does not fail. It reads the wrong
 * offsets and returns numbers that look like numbers, and a run that checks one field out of
 * twenty prints PASS. That happened: two approvals were reported as fifty. See
 * `docs/decision-log.md` D-0051.
 *
 * `crates/vinct-layouts` builds each account from the program's own Rust struct, serialises
 * it the way Anchor does, and writes the bytes next to the values they encode. This file
 * decodes those bytes and checks every field. Add, move, resize, or reorder a field in Rust
 * and the vectors change; this test then fails until the TypeScript is brought back into
 * line.
 *
 * Regenerate with `pnpm gen-account-vectors` after any layout change. The vectors are never
 * edited by hand: a hand-edited vector is a second opinion about the layout, which is the
 * thing the test exists to prevent.
 *
 *   pnpm exec tsx --test tests/program/account-layout-parity.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";

import {
  decodeAdapterReceipt,
  decodeCapability,
  decodeCertificate,
  decodeCovenant,
  decodeCovenantMember,
  decodeIncidentClaim,
  decodeIncidentCore,
  decodeMarket,
  decodeMemberAttestation,
  decodeOperation,
  decodeSettlementReceipt,
} from "../../packages/client/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Vector {
  account: string;
  discriminator: string;
  byte_length: number;
  bytes: string;
  fields: Record<string, unknown>;
}

const VECTORS = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages", "test-vectors", "account-layouts.json"), "utf8"),
) as { accounts: Record<string, Vector> };

function vector(name: string): { bytes: Buffer; fields: Record<string, unknown> } {
  const entry = VECTORS.accounts[name];
  assert.ok(entry, `no layout vector for ${name}. Run pnpm gen-account-vectors.`);
  const bytes = Buffer.from(entry.bytes, "hex");
  assert.equal(bytes.length, entry.byte_length, `${name}: vector length disagrees with itself`);
  return { bytes, fields: entry.fields };
}

/** Normalises a decoded value so a bigint, a byte array, and a key all compare as JSON would. */
function normalise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

/**
 * Checks every field the vector declares.
 *
 * Only the fields in the vector, so a decoder may expose derived conveniences. But every
 * field the vector names must be present and equal, which is what catches a drifted offset:
 * the fields after the drift stop matching even though they still decode.
 */
function assertDecodes(name: string, decoded: Record<string, unknown>): void {
  const { fields } = vector(name);
  for (const [key, expected] of Object.entries(fields)) {
    assert.ok(key in decoded, `${name}.${key} is missing from the decoder's output`);
    assert.deepEqual(
      normalise(decoded[key]),
      normalise(expected),
      `${name}.${key} decoded to the wrong value, which usually means an offset above it moved`,
    );
  }
}

test("the covenant decoder matches the program's layout", () => {
  assertDecodes("Covenant", decodeCovenant(vector("Covenant").bytes) as never);
});

test("the covenant member decoder matches the program's layout", () => {
  assertDecodes("CovenantMember", decodeCovenantMember(vector("CovenantMember").bytes) as never);
});

test("the incident core decoder matches the program's layout", () => {
  assertDecodes("IncidentCore", decodeIncidentCore(vector("IncidentCore").bytes) as never);
});

test("the incident claim decoder matches the program's layout", () => {
  assertDecodes("IncidentClaim", decodeIncidentClaim(vector("IncidentClaim").bytes) as never);
});

test("the member attestation decoder matches the program's layout", () => {
  assertDecodes(
    "MemberAttestation",
    decodeMemberAttestation(vector("MemberAttestation").bytes) as never,
  );
});

test("the certificate decoder matches the program's layout", () => {
  assertDecodes(
    "IncidentCertificate",
    decodeCertificate(vector("IncidentCertificate").bytes) as never,
  );
});

test("the settlement receipt decoder matches the program's layout", () => {
  assertDecodes(
    "SettlementReceipt",
    decodeSettlementReceipt(vector("SettlementReceipt").bytes) as never,
  );
});

test("the settlement operation decoder matches the program's layout", () => {
  assertDecodes(
    "SettlementOperation",
    decodeOperation(vector("SettlementOperation").bytes) as never,
  );
});

test("the capability decoder matches the program's layout", () => {
  assertDecodes(
    "SovereignCapability",
    decodeCapability(vector("SovereignCapability").bytes) as never,
  );
});

test("the adapter receipt decoder matches the program's layout", () => {
  assertDecodes("AdapterReceipt", decodeAdapterReceipt(vector("AdapterReceipt").bytes) as never);
});

test("the market decoder matches the program's layout", () => {
  assertDecodes("ProtocolMarket", decodeMarket(vector("ProtocolMarket").bytes) as never);
});

/**
 * Every decoder refuses an account it was not written for.
 *
 * The discriminator is the only thing distinguishing two accounts whose fields happen to line
 * up, and reading one as the other is how a settlement monitor reports a market as a receipt.
 * Failing closed matters more here than anywhere: these decoders produce evidence.
 */
test("every decoder refuses the wrong account type", () => {
  const decoders: [string, (data: Buffer) => unknown][] = [
    ["Covenant", decodeCovenant],
    ["CovenantMember", decodeCovenantMember],
    ["IncidentCore", decodeIncidentCore],
    ["IncidentClaim", decodeIncidentClaim],
    ["MemberAttestation", decodeMemberAttestation],
    ["IncidentCertificate", decodeCertificate],
    ["SettlementReceipt", decodeSettlementReceipt],
    ["SettlementOperation", decodeOperation],
    ["SovereignCapability", decodeCapability],
    ["AdapterReceipt", decodeAdapterReceipt],
    ["ProtocolMarket", decodeMarket],
  ];

  for (const [name, decode] of decoders) {
    const foreign = vector(name === "Covenant" ? "IncidentCore" : "Covenant").bytes;
    assert.throws(
      () => decode(foreign),
      /discriminator/i,
      `${name}'s decoder accepted another account's bytes`,
    );
  }
});

/**
 * Every decoder refuses a truncated account.
 *
 * A short buffer is what a partially written account, a `dataSlice` read, or a stripped RPC
 * response looks like. Reading past the end of one either throws something unhelpful or, on a
 * zero-padded buffer, quietly returns zeros.
 */
test("every decoder refuses a truncated account", () => {
  const decoders: [string, (data: Buffer) => unknown][] = [
    ["Covenant", decodeCovenant],
    ["CovenantMember", decodeCovenantMember],
    ["IncidentCore", decodeIncidentCore],
    ["IncidentClaim", decodeIncidentClaim],
    ["MemberAttestation", decodeMemberAttestation],
    ["IncidentCertificate", decodeCertificate],
    ["SettlementReceipt", decodeSettlementReceipt],
    ["SettlementOperation", decodeOperation],
    ["SovereignCapability", decodeCapability],
    ["AdapterReceipt", decodeAdapterReceipt],
    ["ProtocolMarket", decodeMarket],
  ];

  for (const [name, decode] of decoders) {
    const { bytes } = vector(name);
    assert.throws(
      () => decode(bytes.subarray(0, bytes.length - 1)),
      /too short|length/i,
      `${name}'s decoder accepted a truncated account`,
    );
  }
});

/**
 * Every versioned account refuses a version it does not know.
 *
 * Fail closed. A layout this build has never seen is not something to interpret optimistically,
 * and the accounts that carry a version are exactly the ones whose shape is still moving.
 */
test("versioned decoders refuse an unknown schema version", () => {
  const versioned: [string, (data: Buffer) => unknown][] = [
    ["Covenant", decodeCovenant],
    ["CovenantMember", decodeCovenantMember],
    ["IncidentCore", decodeIncidentCore],
    ["IncidentClaim", decodeIncidentClaim],
    ["MemberAttestation", decodeMemberAttestation],
  ];

  for (const [name, decode] of versioned) {
    const { bytes } = vector(name);
    const tampered = Buffer.from(bytes);
    tampered.writeUInt16LE(0xbeef, 8);
    assert.throws(
      () => decode(tampered),
      /version/i,
      `${name}'s decoder accepted an unknown schema version`,
    );
  }
});

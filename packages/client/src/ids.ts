/**
 * Program identities and seeds.
 *
 * The program IDs are read from the built IDLs rather than retyped, so a `anchor keys sync`
 * that changes them cannot leave this file quietly disagreeing with the deployed programs.
 */

import { PublicKey } from "@solana/web3.js";

// Imported rather than read from disk, so the same module works in a browser bundle and under
// tsx. The files are the ones `anchor build` writes, and importing them means a bundle carries
// the IDL of the build it was made from rather than whatever happens to be on a filesystem.
import adapterIdl from "../../../target/idl/vinct_adapter.json" with { type: "json" };
import coreIdl from "../../../target/idl/vinct_core.json" with { type: "json" };
import mockProtocolIdl from "../../../target/idl/vinct_mock_protocol.json" with { type: "json" };

interface AnchorIdl {
  address: string;
  instructions: { name: string; discriminator: number[] }[];
  errors?: { code: number; name: string; msg: string }[];
}

export const CORE_IDL = coreIdl as AnchorIdl;
export const ADAPTER_IDL = adapterIdl as AnchorIdl;
export const MOCK_PROTOCOL_IDL = mockProtocolIdl as AnchorIdl;

export const CORE_PROGRAM_ID = new PublicKey(CORE_IDL.address);
export const ADAPTER_PROGRAM_ID = new PublicKey(ADAPTER_IDL.address);
export const MOCK_PROTOCOL_PROGRAM_ID = new PublicKey(MOCK_PROTOCOL_IDL.address);

export const SEEDS = {
  certificate: Buffer.from("certificate"),
  settlement: Buffer.from("settlement"),
  operation: Buffer.from("operation"),
  capability: Buffer.from("capability"),
  adapterSigner: Buffer.from("adapter-signer"),
  adapterReceipt: Buffer.from("adapter-receipt"),
  market: Buffer.from("market"),
} as const;

/** The Anchor discriminator for one instruction, read from its IDL. */
export function discriminator(idl: AnchorIdl, name: string): Buffer {
  const instruction = idl.instructions.find((i) => i.name === name);
  if (!instruction) {
    throw new Error(`instruction ${name} is not in the IDL`);
  }
  return Buffer.from(instruction.discriminator);
}

/** Maps an Anchor custom error code back to its name, for readable failures. */
export function errorName(idl: AnchorIdl, code: number): string | undefined {
  return idl.errors?.find((e) => e.code === code)?.name;
}

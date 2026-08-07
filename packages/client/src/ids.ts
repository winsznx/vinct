/**
 * Program identities and seeds.
 *
 * The program IDs are read from the built IDLs rather than retyped, so a `anchor keys sync`
 * that changes them cannot leave this file quietly disagreeing with the deployed programs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IDL_DIR = join(REPO_ROOT, "target", "idl");

interface AnchorIdl {
  address: string;
  instructions: { name: string; discriminator: number[] }[];
  errors?: { code: number; name: string; msg: string }[];
}

function loadIdl(name: string): AnchorIdl {
  return JSON.parse(readFileSync(join(IDL_DIR, `${name}.json`), "utf8")) as AnchorIdl;
}

export const CORE_IDL = loadIdl("vinct_core");
export const ADAPTER_IDL = loadIdl("vinct_adapter");
export const MOCK_PROTOCOL_IDL = loadIdl("vinct_mock_protocol");

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

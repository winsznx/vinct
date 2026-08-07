/**
 * Every program address VINCT derives.
 *
 * Derivation lives in one place so the client, the tests, and the verifier cannot drift
 * from the programs. A receipt address in particular is load-bearing: the adapter
 * re-derives it from the operation ID and refuses anything else, so a client that computed
 * it differently would simply never succeed.
 */

import { PublicKey } from "@solana/web3.js";

import { ADAPTER_PROGRAM_ID, CORE_PROGRAM_ID, MOCK_PROTOCOL_PROGRAM_ID, SEEDS } from "./ids.js";

export function certificateAddress(operationId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.certificate, Buffer.from(operationId)],
    CORE_PROGRAM_ID,
  )[0];
}

export function settlementReceiptAddress(operationId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.settlement, Buffer.from(operationId)],
    CORE_PROGRAM_ID,
  )[0];
}

export function operationAddress(operationId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.operation, Buffer.from(operationId)],
    CORE_PROGRAM_ID,
  )[0];
}

export function capabilityAddress(
  protocolAuthority: PublicKey,
  covenant: PublicKey,
  policyId: Uint8Array,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.capability, protocolAuthority.toBuffer(), covenant.toBuffer(), Buffer.from(policyId)],
    ADAPTER_PROGRAM_ID,
  )[0];
}

export function adapterSignerAddress(capability: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.adapterSigner, capability.toBuffer()],
    ADAPTER_PROGRAM_ID,
  )[0];
}

export function adapterReceiptAddress(operationId: Uint8Array, capability: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.adapterReceipt, Buffer.from(operationId), capability.toBuffer()],
    ADAPTER_PROGRAM_ID,
  )[0];
}

export function marketAddress(authority: PublicKey, marketId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(marketId);
  return PublicKey.findProgramAddressSync(
    [SEEDS.market, authority.toBuffer(), id],
    MOCK_PROTOCOL_PROGRAM_ID,
  )[0];
}

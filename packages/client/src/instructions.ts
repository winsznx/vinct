/**
 * Instruction builders for the three VINCT programs.
 *
 * Account order in every builder is the order the program declares, because the adapter
 * commits to a hash of exactly that order and will refuse anything else. Nothing here sorts
 * or normalises an account list.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

import { ArgWriter, withDiscriminator } from "./encoding.js";
import {
  ADAPTER_IDL,
  ADAPTER_PROGRAM_ID,
  CORE_IDL,
  CORE_PROGRAM_ID,
  MOCK_PROTOCOL_IDL,
  MOCK_PROTOCOL_PROGRAM_ID,
  discriminator,
} from "./ids.js";
import {
  adapterReceiptAddress,
  adapterSignerAddress,
  certificateAddress,
  operationAddress,
  settlementReceiptAddress,
} from "./pdas.js";
import { sha256 as sha256Bytes } from "./sha256.js";

// ------------------------------------------------------------- mock protocol

export function initializeMarket(
  market: PublicKey,
  authority: PublicKey,
  marketId: bigint,
  demoAuthority: PublicKey | null,
): TransactionInstruction {
  const args = new ArgWriter().u64(marketId).optionPubkey(demoAuthority).finish();
  return new TransactionInstruction({
    programId: MOCK_PROTOCOL_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(MOCK_PROTOCOL_IDL, "initialize_market"), args),
  });
}

export function setAdapter(
  market: PublicKey,
  authority: PublicKey,
  adapterSigner: PublicKey | null,
): TransactionInstruction {
  const args = new ArgWriter().optionPubkey(adapterSigner).finish();
  return new TransactionInstruction({
    programId: MOCK_PROTOCOL_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(MOCK_PROTOCOL_IDL, "set_adapter"), args),
  });
}

export function resetDemoMarket(
  market: PublicKey,
  demoAuthority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: MOCK_PROTOCOL_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: demoAuthority, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(MOCK_PROTOCOL_IDL, "reset_demo_market")),
  });
}

// --------------------------------------------------------------------- core

export interface CertificateArgs {
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

/**
 * Publishes the certificate a certified incident earned.
 *
 * No arguments and no issuing authority. Every field is derived from the released incident
 * core, whose terminal state is the only thing that can produce a certificate. The payer
 * funds the account and gains nothing by it.
 */
export function publishCertificate(
  payer: PublicKey,
  core: PublicKey,
  operationId: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: certificateAddress(operationId), isSigner: false, isWritable: true },
      { pubkey: core, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "publish_certificate")),
  });
}

export function initializeSettlementReceipt(
  payer: PublicKey,
  operationId: Uint8Array,
): TransactionInstruction {
  const args = new ArgWriter().bytes32(operationId).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: settlementReceiptAddress(operationId), isSigner: false, isWritable: true },
      { pubkey: certificateAddress(operationId), isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "initialize_settlement_receipt"), args),
  });
}

export function initializeOperation(
  authority: PublicKey,
  operationId: Uint8Array,
  expectedActionCount: number,
): TransactionInstruction {
  const args = new ArgWriter().bytes32(operationId).u16(expectedActionCount).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: operationAddress(operationId), isSigner: false, isWritable: true },
      { pubkey: certificateAddress(operationId), isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "initialize_operation"), args),
  });
}

/**
 * Delegates the operation account on the base layer.
 *
 * The `#[delegate]` macro inserts the buffer, delegation record, and delegation metadata
 * accounts immediately *before* the delegated account, then appends the owner program, the
 * delegation program, and the system program. That order is read from the built IDL rather
 * than assumed; `the_client_matches_the_idl_account_order` asserts it still holds.
 *
 * An omitted optional validator is passed as the core program ID, which is how Anchor
 * encodes an absent `Option<UncheckedAccount>`.
 */
export function delegateOperation(
  authority: PublicKey,
  operationId: Uint8Array,
  validator: PublicKey | null,
  delegation: {
    buffer: PublicKey;
    record: PublicKey;
    metadata: PublicKey;
    delegationProgram: PublicKey;
  },
): TransactionInstruction {
  const operation = operationAddress(operationId);
  const keys: AccountMeta[] = [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: delegation.buffer, isSigner: false, isWritable: true },
    { pubkey: delegation.record, isSigner: false, isWritable: true },
    { pubkey: delegation.metadata, isSigner: false, isWritable: true },
    { pubkey: operation, isSigner: false, isWritable: true },
    {
      pubkey: validator ?? CORE_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: delegation.delegationProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const args = new ArgWriter().bytes32(operationId).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys,
    data: withDiscriminator(discriminator(CORE_IDL, "delegate_operation"), args),
  });
}

export interface CohortAccounts {
  payer: PublicKey;
  operationId: Uint8Array;
  magicContext: PublicKey;
  magicProgram: PublicKey;
  /** capability, protocolState, adapterReceipt, adapterSigner, per adapter action. */
  adapters: {
    capability: PublicKey;
    protocolState: PublicKey;
    adapterReceipt: PublicKey;
    adapterSigner: PublicKey;
  }[];
}

export function scheduleSettlementCohort(
  accounts: CohortAccounts,
  adapterComputeUnits: number,
  settlementComputeUnits: number,
): TransactionInstruction {
  const args = new ArgWriter()
    .bytes32(accounts.operationId)
    .u16(accounts.adapters.length)
    .u32(adapterComputeUnits)
    .u32(settlementComputeUnits)
    .finish();

  const keys: AccountMeta[] = [
    { pubkey: accounts.payer, isSigner: true, isWritable: true },
    { pubkey: operationAddress(accounts.operationId), isSigner: false, isWritable: true },
    { pubkey: certificateAddress(accounts.operationId), isSigner: false, isWritable: false },
    {
      pubkey: settlementReceiptAddress(accounts.operationId),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: ADAPTER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MOCK_PROTOCOL_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    // Appended by #[commit].
    { pubkey: accounts.magicProgram, isSigner: false, isWritable: false },
    { pubkey: accounts.magicContext, isSigner: false, isWritable: true },
  ];

  for (const adapter of accounts.adapters) {
    keys.push(
      { pubkey: adapter.capability, isSigner: false, isWritable: false },
      { pubkey: adapter.protocolState, isSigner: false, isWritable: false },
      { pubkey: adapter.adapterReceipt, isSigner: false, isWritable: false },
      { pubkey: adapter.adapterSigner, isSigner: false, isWritable: false },
    );
  }

  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys,
    data: withDiscriminator(discriminator(CORE_IDL, "schedule_settlement_cohort"), args),
  });
}

/**
 * The Magic Action target, buildable directly for the local comparison run.
 *
 * `#[action]` appends `escrow_auth` and `escrow`; a scheduled action gets them from the
 * SDK, a direct call has to supply them.
 */
export function finalizeSettlement(
  operationId: Uint8Array,
  observedActionCount: number,
  escrowAuth: PublicKey,
  escrow: PublicKey,
): TransactionInstruction {
  const args = new ArgWriter().bytes32(operationId).u16(observedActionCount).finish();
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: settlementReceiptAddress(operationId), isSigner: false, isWritable: true },
      { pubkey: certificateAddress(operationId), isSigner: false, isWritable: false },
      { pubkey: escrowAuth, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(CORE_IDL, "finalize_settlement"), args),
  });
}

// ------------------------------------------------------------------ adapter

export interface InstallCapabilityArgs {
  protocolState: PublicKey;
  coreProgram: PublicKey;
  adapterVersion: number;
  clusterGenesisHash: Uint8Array;
  covenant: PublicKey;
  circleEpoch: bigint;
  policyId: Uint8Array;
  memberSetHash: Uint8Array;
  /** 0 = PauseNewBorrowing. */
  actionCategory: number;
  targetProgram: PublicKey;
  instructionDiscriminator: Uint8Array;
  actionTemplateHash: Uint8Array;
  instructionDataHash: Uint8Array;
  maxEffect: { mayPause: boolean; mayUnpause: boolean; maxValueMoved: bigint };
  validFromSlot: bigint;
  expiresAtSlot: bigint;
}

/**
 * One slot in an armed action template.
 *
 * Roles are the closed set `vinct_types::action::AccountRoleV1` defines, by Borsh
 * discriminant. There is no variant a caller can invent and no seed recipe to supply: a
 * template that let a client describe how to derive an account would be a forwarding surface
 * wearing a commitment.
 */
export type TemplateSlot =
  | { kind: "fixed"; pubkey: PublicKey; isSigner: boolean; isWritable: boolean }
  | { kind: "adapterReceipt"; isSigner: boolean; isWritable: boolean }
  | { kind: "certificate"; isSigner: boolean; isWritable: boolean };

const TEMPLATE_ROLE = { fixed: 0, adapterReceipt: 1, certificate: 3 } as const;

/**
 * The commitment a protocol authority signs when it arms its adapter.
 *
 * Mirrors `hash_action_template` in the adapter byte for byte. Derived slots contribute their
 * role and their flags and no address, which is what lets one arming serve every future
 * operation under the same covenant, policy, and epoch.
 */
export function actionTemplateHash(slots: TemplateSlot[]): Uint8Array {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(slots.length);
  const parts: Buffer[] = [count];
  for (const slot of slots) {
    const role = TEMPLATE_ROLE[slot.kind === "fixed" ? "fixed" : slot.kind];
    parts.push(
      Buffer.from([role]),
      slot.kind === "fixed" ? slot.pubkey.toBuffer() : Buffer.alloc(32),
      Buffer.from([slot.isSigner ? 1 : 0]),
      Buffer.from([slot.isWritable ? 1 : 0]),
    );
  }
  return new Uint8Array(sha256Bytes(Buffer.concat(parts)));
}

/**
 * The template for `execute_bounded_action` on one protocol.
 *
 * Takes no operation ID, which is the property the whole shape exists for: a protocol arms
 * before any incident, and one arming covers every valid incident afterwards.
 */
export function executeBoundedActionTemplate(
  capability: PublicKey,
  protocolState: PublicKey,
  adapterSigner: PublicKey,
  targetProgram: PublicKey,
): TemplateSlot[] {
  return [
    { kind: "certificate", isSigner: false, isWritable: false },
    { kind: "fixed", pubkey: capability, isSigner: false, isWritable: true },
    { kind: "fixed", pubkey: protocolState, isSigner: false, isWritable: true },
    { kind: "adapterReceipt", isSigner: false, isWritable: true },
    { kind: "fixed", pubkey: adapterSigner, isSigner: false, isWritable: false },
    { kind: "fixed", pubkey: targetProgram, isSigner: false, isWritable: false },
  ];
}

export function installCapability(
  capability: PublicKey,
  protocolAuthority: PublicKey,
  args: InstallCapabilityArgs,
): TransactionInstruction {
  const encoded = new ArgWriter()
    .pubkey(args.protocolState)
    .pubkey(args.coreProgram)
    .u16(args.adapterVersion)
    .bytes32(args.clusterGenesisHash)
    .pubkey(args.covenant)
    .u64(args.circleEpoch)
    .bytes32(args.policyId)
    .bytes32(args.memberSetHash)
    .u8(args.actionCategory)
    .pubkey(args.targetProgram)
    .bytes8(args.instructionDiscriminator)
    .bytes32(args.actionTemplateHash)
    .bytes32(args.instructionDataHash)
    .bool(args.maxEffect.mayPause)
    .bool(args.maxEffect.mayUnpause)
    .u64(args.maxEffect.maxValueMoved)
    .u64(args.validFromSlot)
    .u64(args.expiresAtSlot)
    .finish();

  return new TransactionInstruction({
    programId: ADAPTER_PROGRAM_ID,
    keys: [
      { pubkey: capability, isSigner: false, isWritable: true },
      { pubkey: adapterSignerAddress(capability), isSigner: false, isWritable: false },
      { pubkey: protocolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(ADAPTER_IDL, "install_capability"), encoded),
  });
}

function capabilityAction(
  name: string,
  capability: PublicKey,
  protocolAuthority: PublicKey,
  args: Buffer,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ADAPTER_PROGRAM_ID,
    keys: [
      { pubkey: capability, isSigner: false, isWritable: true },
      { pubkey: protocolAuthority, isSigner: true, isWritable: false },
    ],
    data: withDiscriminator(discriminator(ADAPTER_IDL, name), args),
  });
}

export function armCapability(
  capability: PublicKey,
  protocolAuthority: PublicKey,
  adapterVersion: number,
): TransactionInstruction {
  return capabilityAction(
    "arm_capability",
    capability,
    protocolAuthority,
    new ArgWriter().u16(adapterVersion).finish(),
  );
}

export function suspendCapability(
  capability: PublicKey,
  protocolAuthority: PublicKey,
): TransactionInstruction {
  return capabilityAction("suspend_capability", capability, protocolAuthority, Buffer.alloc(0));
}

export function initializeAdapterReceipt(
  payer: PublicKey,
  capability: PublicKey,
  operationId: Uint8Array,
): TransactionInstruction {
  const args = new ArgWriter().bytes32(operationId).finish();
  return new TransactionInstruction({
    programId: ADAPTER_PROGRAM_ID,
    keys: [
      {
        pubkey: adapterReceiptAddress(operationId, capability),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: capability, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(ADAPTER_IDL, "initialize_adapter_receipt"), args),
  });
}

/**
 * The six accounts an adapter action commits to, in the adapter's declared order.
 *
 * This exact list, in this exact order, is what the adapter rebuilds when it checks the
 * template commitment. Two of the six are operation-derived and the adapter re-derives them
 * itself; the other four are what a protocol authority pinned when it armed.
 */
export function executeBoundedActionAccounts(
  operationId: Uint8Array,
  capability: PublicKey,
  protocolState: PublicKey,
): AccountMeta[] {
  return [
    { pubkey: certificateAddress(operationId), isSigner: false, isWritable: false },
    { pubkey: capability, isSigner: false, isWritable: true },
    { pubkey: protocolState, isSigner: false, isWritable: true },
    {
      pubkey: adapterReceiptAddress(operationId, capability),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: adapterSignerAddress(capability), isSigner: false, isWritable: false },
    { pubkey: MOCK_PROTOCOL_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

export function executeBoundedAction(
  operationId: Uint8Array,
  capability: PublicKey,
  protocolState: PublicKey,
  escrowAuth: PublicKey,
  escrow: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ADAPTER_PROGRAM_ID,
    keys: [
      ...executeBoundedActionAccounts(operationId, capability, protocolState),
      { pubkey: escrowAuth, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: false },
    ],
    data: withDiscriminator(discriminator(ADAPTER_IDL, "execute_bounded_action")),
  });
}

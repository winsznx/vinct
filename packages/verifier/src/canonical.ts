/**
 * VINCT's canonical structures, encoded and decoded independently of the Rust crate.
 *
 * Field order here is the field order in `crates/vinct-types`. Borsh has no field names
 * on the wire, so a reordering in either implementation shows up as a byte mismatch in
 * the parity check rather than as a silent divergence.
 *
 * Account metas are never sorted anywhere in this file. Solana instruction order is
 * semantic, and normalising it would change which account a program writes to.
 */

import { BorshReader, BorshWriter, fromHex } from "./borsh.js";
import { sha256 as sha256Bytes } from "../../client/src/sha256.js";

export type Digest32 = Uint8Array;

// ---------------------------------------------------------------- primitives

export function sha256(bytes: Uint8Array): Digest32 {
  return new Uint8Array(sha256Bytes(bytes));
}

/** A domain separator is `sha256(label)`. */
export function domain(label: string): Digest32 {
  return sha256(new TextEncoder().encode(label));
}

export const DOMAINS = {
  COVENANT_V1: "VINCT_COVENANT_V1",
  MEMBER_SET_V1: "VINCT_MEMBER_SET_V1",
  MEMBER_V1: "VINCT_MEMBER_V1",
  POLICY_V1: "VINCT_POLICY_V1",
  POLICY_SET_V1: "VINCT_POLICY_SET_V1",
  ADAPTER_SET_V1: "VINCT_ADAPTER_SET_V1",
  ACTION_TEMPLATE_V1: "VINCT_ACTION_TEMPLATE_V1",
  ACTION_BUNDLE_V1: "VINCT_ACTION_BUNDLE_V1",
  OPERATION_V1: "VINCT_OPERATION_V1",
  CERTIFICATE_V1: "VINCT_CERTIFICATE_V1",
  ATTESTATION_V1: "VINCT_ATTESTATION_V1",
  INCIDENT_CLAIM_V1: "VINCT_INCIDENT_CLAIM_V1",
  RECOVERY_V1: "VINCT_RECOVERY_V1",
} as const;

/** `sha256(domain || u32le(count) || digest*)`. Order is significant and never imposed here. */
export function hashDigestList(domainSeparator: Digest32, items: readonly Digest32[]): Digest32 {
  const writer = new BorshWriter();
  writer.fixedBytes(domainSeparator, 32);
  writer.u32(items.length);
  for (const item of items) {
    writer.fixedBytes(item, 32);
  }
  return sha256(writer.finish());
}

// ------------------------------------------------------------------- enums

export const MEMBER_ROLES = ["protocol", "responder", "steward"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const ACTION_CATEGORIES = ["pause_new_borrowing"] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

export const DEPENDENCY_NAMESPACES = [
  "solana_program",
  "price_feed",
  "bridge",
  "offchain_service",
] as const;
export type DependencyNamespace = (typeof DEPENDENCY_NAMESPACES)[number];

export const ACCOUNT_ROLES = [
  "fixed",
  "adapter_receipt",
  "settlement_receipt",
  "certificate",
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const DECISIONS = ["approve", "reject", "abstain"] as const;
export type Decision = (typeof DECISIONS)[number];

export const ATTESTATION_STATES = ["submitted", "superseded", "invalidated_by_quarantine"] as const;
export type AttestationState = (typeof ATTESTATION_STATES)[number];

export const SIGNAL_CATEGORIES = [
  "oracle_deviation",
  "dependency_unavailable",
  "unexpected_authority_change",
  "unexplained_outflow",
] as const;
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

export const CONFIDENCE_BUCKETS = ["low", "medium", "high"] as const;
export type ConfidenceBucket = (typeof CONFIDENCE_BUCKETS)[number];

function variantIndex<T extends string>(variants: readonly T[], value: T): number {
  const index = variants.indexOf(value);
  if (index < 0) {
    throw new Error(`unknown variant: ${value}`);
  }
  return index;
}

function variantAt<T extends string>(variants: readonly T[], index: number): T {
  const value = variants[index];
  if (value === undefined) {
    throw new Error(`variant index out of range: ${index}`);
  }
  return value;
}

// ------------------------------------------------------------------ structs

export interface EffectLimit {
  mayPause: boolean;
  mayUnpause: boolean;
  maxValueMoved: bigint;
}

export interface CanonicalAccountMeta {
  pubkey: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

export interface CanonicalAction {
  actionIndex: number;
  adapterProgramId: Uint8Array;
  adapterVersion: number;
  adapterCapability: Uint8Array;
  targetProgramId: Uint8Array;
  instructionDiscriminator: Uint8Array;
  accountMetas: CanonicalAccountMeta[];
  instructionData: Uint8Array;
  effectLimit: EffectLimit;
  capabilityNonce: bigint;
}

export interface ActionBundle {
  domain: Uint8Array;
  clusterGenesisHash: Uint8Array;
  covenant: Uint8Array;
  circleEpoch: bigint;
  incidentId: bigint;
  policyId: Uint8Array;
  memberSetHash: Uint8Array;
  bundleExpirySlot: bigint;
  operationId: Uint8Array;
  actions: CanonicalAction[];
}

export interface TemplateAccountMeta {
  role: AccountRole;
  pubkey: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

export interface ActionTemplate {
  domain: Uint8Array;
  /**
   * The template layout version.
   *
   * Separate from the domain separator: the domain says which kind of thing this is, the
   * version says which shape of that kind. A template written under a later layout is refused
   * rather than reinterpreted.
   */
  templateVersion: number;
  actionIndex: number;
  clusterGenesisHash: Uint8Array;
  covenant: Uint8Array;
  circleEpoch: bigint;
  policyId: Uint8Array;
  actionCategory: ActionCategory;
  adapterProgramId: Uint8Array;
  adapterVersion: number;
  adapterCapability: Uint8Array;
  targetProgramId: Uint8Array;
  instructionDiscriminator: Uint8Array;
  accountMetas: TemplateAccountMeta[];
  instructionData: Uint8Array;
  effectLimit: EffectLimit;
}

export interface Member {
  domain: Uint8Array;
  member: Uint8Array;
  role: MemberRole;
  adapterCapability: Uint8Array;
  adapterVersion: number;
}

export interface ResponsePolicy {
  domain: Uint8Array;
  policyId: Uint8Array;
  actionCategory: ActionCategory;
  dependencyNamespace: DependencyNamespace;
  dependencyId: Uint8Array;
  eligibleMemberSetHash: Uint8Array;
  requiredApprovals: number;
  maximumRejections: number;
  requiredRoles: MemberRole[];
  responseWindowSlots: bigint;
  certificateTtlSlots: bigint;
  actionBundleTemplateHash: Uint8Array;
  version: number;
}

export interface Certificate {
  domain: Uint8Array;
  clusterGenesisHash: Uint8Array;
  covenant: Uint8Array;
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

export interface CovenantDigest {
  domain: Uint8Array;
  clusterGenesisHash: Uint8Array;
  covenant: Uint8Array;
  circleEpoch: bigint;
  steward: Uint8Array;
  memberSetHash: Uint8Array;
  policiesHash: Uint8Array;
  adapterSetHash: Uint8Array;
  validFromSlot: bigint;
  expiresAtSlot: bigint;
}

export interface Attestation {
  domain: Uint8Array;
  covenant: Uint8Array;
  circleEpoch: bigint;
  incidentId: bigint;
  member: Uint8Array;
  decision: Decision;
  submissionNonce: bigint;
  submittedAtSlot: bigint;
  state: AttestationState;
}

export interface IncidentClaim {
  domain: Uint8Array;
  dependencyNamespace: DependencyNamespace;
  dependencyId: Uint8Array;
  observationWindowStart: bigint;
  observationWindowEnd: bigint;
  claimSchemaHash: Uint8Array;
  privateEvidenceDigest: Uint8Array;
  signalCategory: SignalCategory;
  confidenceBucket: ConfidenceBucket;
  requestedActionCategory: ActionCategory;
  submitter: Uint8Array;
  submissionNonce: bigint;
}

// ------------------------------------------------------------------ encoders

function writeEffectLimit(writer: BorshWriter, limit: EffectLimit): void {
  writer.bool(limit.mayPause).bool(limit.mayUnpause).u64(limit.maxValueMoved);
}

function readEffectLimit(reader: BorshReader): EffectLimit {
  return {
    mayPause: reader.bool(),
    mayUnpause: reader.bool(),
    maxValueMoved: reader.u64(),
  };
}

function writeCanonicalAccountMeta(writer: BorshWriter, meta: CanonicalAccountMeta): void {
  writer.fixedBytes(meta.pubkey, 32).bool(meta.isSigner).bool(meta.isWritable);
}

function readCanonicalAccountMeta(reader: BorshReader): CanonicalAccountMeta {
  return {
    pubkey: reader.fixedBytes(32),
    isSigner: reader.bool(),
    isWritable: reader.bool(),
  };
}

function writeCanonicalAction(writer: BorshWriter, action: CanonicalAction): void {
  writer
    .u16(action.actionIndex)
    .fixedBytes(action.adapterProgramId, 32)
    .u16(action.adapterVersion)
    .fixedBytes(action.adapterCapability, 32)
    .fixedBytes(action.targetProgramId, 32)
    .fixedBytes(action.instructionDiscriminator, 8)
    .vec(action.accountMetas, writeCanonicalAccountMeta)
    .bytes(action.instructionData);
  writeEffectLimit(writer, action.effectLimit);
  writer.u64(action.capabilityNonce);
}

function readCanonicalAction(reader: BorshReader): CanonicalAction {
  return {
    actionIndex: reader.u16(),
    adapterProgramId: reader.fixedBytes(32),
    adapterVersion: reader.u16(),
    adapterCapability: reader.fixedBytes(32),
    targetProgramId: reader.fixedBytes(32),
    instructionDiscriminator: reader.fixedBytes(8),
    accountMetas: reader.vec(readCanonicalAccountMeta),
    instructionData: reader.bytes(),
    effectLimit: readEffectLimit(reader),
    capabilityNonce: reader.u64(),
  };
}

export function encodeActionBundle(bundle: ActionBundle): Uint8Array {
  const writer = new BorshWriter();
  writer
    .fixedBytes(bundle.domain, 32)
    .fixedBytes(bundle.clusterGenesisHash, 32)
    .fixedBytes(bundle.covenant, 32)
    .u64(bundle.circleEpoch)
    .u64(bundle.incidentId)
    .fixedBytes(bundle.policyId, 32)
    .fixedBytes(bundle.memberSetHash, 32)
    .u64(bundle.bundleExpirySlot)
    .fixedBytes(bundle.operationId, 32)
    .vec(bundle.actions, writeCanonicalAction);
  return writer.finish();
}

export function decodeActionBundle(bytes: Uint8Array): ActionBundle {
  const reader = new BorshReader(bytes);
  const bundle: ActionBundle = {
    domain: reader.fixedBytes(32),
    clusterGenesisHash: reader.fixedBytes(32),
    covenant: reader.fixedBytes(32),
    circleEpoch: reader.u64(),
    incidentId: reader.u64(),
    policyId: reader.fixedBytes(32),
    memberSetHash: reader.fixedBytes(32),
    bundleExpirySlot: reader.u64(),
    operationId: reader.fixedBytes(32),
    actions: reader.vec(readCanonicalAction),
  };
  reader.finish();
  return bundle;
}

function writeTemplateAccountMeta(writer: BorshWriter, meta: TemplateAccountMeta): void {
  writer
    .u8(variantIndex(ACCOUNT_ROLES, meta.role))
    .fixedBytes(meta.pubkey, 32)
    .bool(meta.isSigner)
    .bool(meta.isWritable);
}

function readTemplateAccountMeta(reader: BorshReader): TemplateAccountMeta {
  return {
    role: variantAt(ACCOUNT_ROLES, reader.u8()),
    pubkey: reader.fixedBytes(32),
    isSigner: reader.bool(),
    isWritable: reader.bool(),
  };
}

export function encodeActionTemplate(template: ActionTemplate): Uint8Array {
  const writer = new BorshWriter();
  writeActionTemplateInto(writer, template);
  return writer.finish();
}

function writeActionTemplateInto(writer: BorshWriter, template: ActionTemplate): void {
  writer
    .fixedBytes(template.domain, 32)
    .u16(template.templateVersion)
    .u16(template.actionIndex)
    .fixedBytes(template.clusterGenesisHash, 32)
    .fixedBytes(template.covenant, 32)
    .u64(template.circleEpoch)
    .fixedBytes(template.policyId, 32)
    .u8(variantIndex(ACTION_CATEGORIES, template.actionCategory))
    .fixedBytes(template.adapterProgramId, 32)
    .u16(template.adapterVersion)
    .fixedBytes(template.adapterCapability, 32)
    .fixedBytes(template.targetProgramId, 32)
    .fixedBytes(template.instructionDiscriminator, 8)
    .vec(template.accountMetas, writeTemplateAccountMeta)
    .bytes(template.instructionData);
  writeEffectLimit(writer, template.effectLimit);
}

function readActionTemplate(reader: BorshReader): ActionTemplate {
  return {
    domain: reader.fixedBytes(32),
    templateVersion: reader.u16(),
    actionIndex: reader.u16(),
    clusterGenesisHash: reader.fixedBytes(32),
    covenant: reader.fixedBytes(32),
    circleEpoch: reader.u64(),
    policyId: reader.fixedBytes(32),
    actionCategory: variantAt(ACTION_CATEGORIES, reader.u8()),
    adapterProgramId: reader.fixedBytes(32),
    adapterVersion: reader.u16(),
    adapterCapability: reader.fixedBytes(32),
    targetProgramId: reader.fixedBytes(32),
    instructionDiscriminator: reader.fixedBytes(8),
    accountMetas: reader.vec(readTemplateAccountMeta),
    instructionData: reader.bytes(),
    effectLimit: readEffectLimit(reader),
  };
}

export function encodeActionBundleTemplate(actions: readonly ActionTemplate[]): Uint8Array {
  const writer = new BorshWriter();
  writer.vec(actions, writeActionTemplateInto);
  return writer.finish();
}

export function decodeActionBundleTemplate(bytes: Uint8Array): ActionTemplate[] {
  const reader = new BorshReader(bytes);
  const actions = reader.vec(readActionTemplate);
  reader.finish();
  return actions;
}

export function encodeMember(member: Member): Uint8Array {
  return new BorshWriter()
    .fixedBytes(member.domain, 32)
    .fixedBytes(member.member, 32)
    .u8(variantIndex(MEMBER_ROLES, member.role))
    .fixedBytes(member.adapterCapability, 32)
    .u16(member.adapterVersion)
    .finish();
}

export function encodeResponsePolicy(policy: ResponsePolicy): Uint8Array {
  const writer = new BorshWriter();
  writer
    .fixedBytes(policy.domain, 32)
    .fixedBytes(policy.policyId, 32)
    .u8(variantIndex(ACTION_CATEGORIES, policy.actionCategory))
    .u8(variantIndex(DEPENDENCY_NAMESPACES, policy.dependencyNamespace))
    .fixedBytes(policy.dependencyId, 32)
    .fixedBytes(policy.eligibleMemberSetHash, 32)
    .u8(policy.requiredApprovals)
    .u8(policy.maximumRejections)
    .vec(policy.requiredRoles, (w, role) => {
      w.u8(variantIndex(MEMBER_ROLES, role));
    })
    .u64(policy.responseWindowSlots)
    .u64(policy.certificateTtlSlots)
    .fixedBytes(policy.actionBundleTemplateHash, 32)
    .u16(policy.version);
  return writer.finish();
}

export function encodeCertificate(certificate: Certificate): Uint8Array {
  return new BorshWriter()
    .fixedBytes(certificate.domain, 32)
    .fixedBytes(certificate.clusterGenesisHash, 32)
    .fixedBytes(certificate.covenant, 32)
    .u64(certificate.circleEpoch)
    .u64(certificate.incidentId)
    .fixedBytes(certificate.policyId, 32)
    .fixedBytes(certificate.memberSetHash, 32)
    .fixedBytes(certificate.actionBundleHash, 32)
    .fixedBytes(certificate.operationId, 32)
    .u64(certificate.certificateNonce)
    .u8(certificate.approvalCount)
    .u8(certificate.rejectionCount)
    .u64(certificate.certifiedAtSlot)
    .u64(certificate.expiresAtSlot)
    .finish();
}

export function encodeCovenantDigest(digest: CovenantDigest): Uint8Array {
  return new BorshWriter()
    .fixedBytes(digest.domain, 32)
    .fixedBytes(digest.clusterGenesisHash, 32)
    .fixedBytes(digest.covenant, 32)
    .u64(digest.circleEpoch)
    .fixedBytes(digest.steward, 32)
    .fixedBytes(digest.memberSetHash, 32)
    .fixedBytes(digest.policiesHash, 32)
    .fixedBytes(digest.adapterSetHash, 32)
    .u64(digest.validFromSlot)
    .u64(digest.expiresAtSlot)
    .finish();
}

export function encodeAttestation(attestation: Attestation): Uint8Array {
  return new BorshWriter()
    .fixedBytes(attestation.domain, 32)
    .fixedBytes(attestation.covenant, 32)
    .u64(attestation.circleEpoch)
    .u64(attestation.incidentId)
    .fixedBytes(attestation.member, 32)
    .u8(variantIndex(DECISIONS, attestation.decision))
    .u64(attestation.submissionNonce)
    .u64(attestation.submittedAtSlot)
    .u8(variantIndex(ATTESTATION_STATES, attestation.state))
    .finish();
}

export function encodeIncidentClaim(claim: IncidentClaim): Uint8Array {
  return new BorshWriter()
    .fixedBytes(claim.domain, 32)
    .u8(variantIndex(DEPENDENCY_NAMESPACES, claim.dependencyNamespace))
    .fixedBytes(claim.dependencyId, 32)
    .i64(claim.observationWindowStart)
    .i64(claim.observationWindowEnd)
    .fixedBytes(claim.claimSchemaHash, 32)
    .fixedBytes(claim.privateEvidenceDigest, 32)
    .u8(variantIndex(SIGNAL_CATEGORIES, claim.signalCategory))
    .u8(variantIndex(CONFIDENCE_BUCKETS, claim.confidenceBucket))
    .u8(variantIndex(ACTION_CATEGORIES, claim.requestedActionCategory))
    .fixedBytes(claim.submitter, 32)
    .u64(claim.submissionNonce)
    .finish();
}

// --------------------------------------------------------------- derivations

export interface OperationInputs {
  clusterGenesisHash: Uint8Array;
  covenant: Uint8Array;
  circleEpoch: bigint;
  incidentId: bigint;
  policyId: Uint8Array;
  memberSetHash: Uint8Array;
  actionBundleTemplateHash: Uint8Array;
  certificateNonce: bigint;
}

/**
 * The operation ID.
 *
 * Derived from the policy's registered *template* hash, never from the concrete bundle
 * hash. The concrete bundle carries the operation ID and its account metas hold receipt
 * addresses seeded by it, so deriving the operation ID from the bundle would be circular.
 * See docs/decision-log.md entry D-0012.
 */
export function operationId(inputs: OperationInputs): Digest32 {
  const writer = new BorshWriter();
  writer
    .fixedBytes(domain(DOMAINS.OPERATION_V1), 32)
    .fixedBytes(inputs.clusterGenesisHash, 32)
    .fixedBytes(inputs.covenant, 32)
    .u64(inputs.circleEpoch)
    .u64(inputs.incidentId)
    .fixedBytes(inputs.policyId, 32)
    .fixedBytes(inputs.memberSetHash, 32)
    .fixedBytes(inputs.actionBundleTemplateHash, 32)
    .u64(inputs.certificateNonce);
  return sha256(writer.finish());
}

export function recoveryOperationId(
  originalOperationId: Uint8Array,
  covenant: Uint8Array,
  circleEpoch: bigint,
  incidentId: bigint,
  recoveryNonce: bigint,
): Digest32 {
  const writer = new BorshWriter();
  writer
    .fixedBytes(domain(DOMAINS.RECOVERY_V1), 32)
    .fixedBytes(originalOperationId, 32)
    .fixedBytes(covenant, 32)
    .u64(circleEpoch)
    .u64(incidentId)
    .u64(recoveryNonce);
  return sha256(writer.finish());
}

/** Commitment to an epoch's armed adapter set, ordered by capability address. */
export function adapterSetHash(capabilities: readonly [Uint8Array, number][]): Digest32 {
  const ordered = [...capabilities].sort(([a, aVersion], [b, bVersion]) => {
    for (let index = 0; index < 32; index += 1) {
      const left = a[index] ?? 0;
      const right = b[index] ?? 0;
      if (left !== right) return left - right;
    }
    return aVersion - bVersion;
  });
  const digests = ordered.map(([capability, version]) => {
    const buffer = new Uint8Array(34);
    buffer.set(capability, 0);
    new DataView(buffer.buffer).setUint16(32, version, true);
    return sha256(buffer);
  });
  return hashDigestList(domain(DOMAINS.ADAPTER_SET_V1), digests);
}

export { fromHex, toHex, bytesEqual } from "./borsh.js";

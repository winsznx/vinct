/**
 * Cross-language parity against the canonical vectors.
 *
 * Three checks per entry, in increasing strength:
 *
 *   1. `sha256(borsh_hex)` matches the recorded digest. Weak on its own: it only proves
 *      the vector file is internally consistent.
 *   2. This package re-encodes the entry from its structured fields and produces the same
 *      bytes. This is the real parity check, because it exercises an independent encoder.
 *   3. For the action bundle, this package decodes `borsh_hex`, re-encodes it, and gets
 *      the identical bytes back. That covers the mutated shapes too, which carry no
 *      structured fields.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOMAINS,
  type ActionBundle,
  type ActionTemplate,
  type Attestation,
  type Certificate,
  type CovenantDigest,
  type IncidentClaim,
  type Member,
  type ResponsePolicy,
  adapterSetHash,
  bytesEqual,
  decodeActionBundle,
  decodeActionBundleTemplate,
  domain,
  encodeActionBundle,
  encodeActionBundleTemplate,
  encodeAttestation,
  encodeCertificate,
  encodeCovenantDigest,
  encodeIncidentClaim,
  encodeMember,
  encodeResponsePolicy,
  fromHex,
  hashDigestList,
  operationId,
  recoveryOperationId,
  sha256,
  toHex,
} from "./canonical.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VECTOR_PATH = join(PACKAGE_ROOT, "..", "test-vectors", "canonical-vectors.json");

export interface VectorEntry {
  name: string;
  fields: Record<string, unknown>;
  borsh_hex: string;
  borsh_len: number;
  sha256: string;
}

export interface MutationEntry {
  mutation: string;
  rejected: boolean;
  reason?: string;
  borsh_hex?: string;
  sha256?: string;
}

export interface CanonicalVectors {
  schema: string;
  domains: { label: string; sha256: string }[];
  members: { entries: VectorEntry[]; member_set_hash: string; ordering_rule: string };
  policy: VectorEntry;
  policies_hash: string;
  adapter_set_hash: string;
  action_templates: VectorEntry[];
  bundle_template: VectorEntry;
  bundle_template_hash: string;
  operation_id: { inputs: Record<string, string>; encoding: string; sha256: string };
  action_bundle: VectorEntry;
  action_bundle_mutations: MutationEntry[];
  certificate: VectorEntry;
  covenant_digest: VectorEntry;
  attestation: VectorEntry;
  incident_claim: VectorEntry;
  recovery_operation_id: {
    inputs: Record<string, string>;
    sha256: string;
    differs_from_original: boolean;
  };
}

export function loadVectors(path: string = DEFAULT_VECTOR_PATH): CanonicalVectors {
  return JSON.parse(readFileSync(path, "utf8")) as CanonicalVectors;
}

/** One parity finding. An empty result list means full agreement. */
export interface ParityFailure {
  entry: string;
  check: string;
  expected: string;
  actual: string;
}

function field(entry: VectorEntry, name: string): string {
  const value = entry.fields[name];
  if (typeof value !== "string") {
    throw new Error(`${entry.name}.${name} is not a string`);
  }
  return value;
}

function numberField(entry: VectorEntry, name: string): number {
  const value = entry.fields[name];
  if (typeof value !== "number") {
    throw new Error(`${entry.name}.${name} is not a number`);
  }
  return value;
}

function bytesField(entry: VectorEntry, name: string): Uint8Array {
  return fromHex(field(entry, name));
}

function bigintField(entry: VectorEntry, name: string): bigint {
  return BigInt(field(entry, name));
}

function list(entry: VectorEntry, name: string): Record<string, unknown>[] {
  const value = entry.fields[name];
  if (!Array.isArray(value)) {
    throw new Error(`${entry.name}.${name} is not an array`);
  }
  return value as Record<string, unknown>[];
}

function str(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string") {
    throw new Error(`expected string at ${name}`);
  }
  return value;
}

function num(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value !== "number") {
    throw new Error(`expected number at ${name}`);
  }
  return value;
}

function flag(source: Record<string, unknown>, name: string): boolean {
  const value = source[name];
  if (typeof value !== "boolean") {
    throw new Error(`expected boolean at ${name}`);
  }
  return value;
}

function effectLimitFrom(source: Record<string, unknown>) {
  const limit = source.effect_limit as Record<string, unknown>;
  return {
    mayPause: flag(limit, "may_pause"),
    mayUnpause: flag(limit, "may_unpause"),
    maxValueMoved: BigInt(str(limit, "max_value_moved")),
  };
}

/** Rebuilds the action bundle from its structured fields. */
function rebuildActionBundle(entry: VectorEntry): ActionBundle {
  return {
    domain: bytesField(entry, "domain"),
    clusterGenesisHash: bytesField(entry, "cluster_genesis_hash"),
    covenant: bytesField(entry, "covenant"),
    circleEpoch: bigintField(entry, "circle_epoch"),
    incidentId: bigintField(entry, "incident_id"),
    policyId: bytesField(entry, "policy_id"),
    memberSetHash: bytesField(entry, "member_set_hash"),
    bundleExpirySlot: bigintField(entry, "bundle_expiry_slot"),
    operationId: bytesField(entry, "operation_id"),
    actions: list(entry, "actions").map((action) => ({
      actionIndex: num(action, "action_index"),
      adapterProgramId: fromHex(str(action, "adapter_program_id")),
      adapterVersion: num(action, "adapter_version"),
      adapterCapability: fromHex(str(action, "adapter_capability")),
      targetProgramId: fromHex(str(action, "target_program_id")),
      instructionDiscriminator: fromHex(str(action, "instruction_discriminator")),
      accountMetas: (action.account_metas as Record<string, unknown>[]).map((meta) => ({
        pubkey: fromHex(str(meta, "pubkey")),
        isSigner: flag(meta, "is_signer"),
        isWritable: flag(meta, "is_writable"),
      })),
      instructionData: fromHex(str(action, "instruction_data")),
      effectLimit: effectLimitFrom(action),
      capabilityNonce: BigInt(str(action, "capability_nonce")),
    })),
  };
}

function rebuildActionTemplate(entry: VectorEntry): ActionTemplate {
  return {
    domain: bytesField(entry, "domain"),
    templateVersion: numberField(entry, "template_version"),
    actionIndex: numberField(entry, "action_index"),
    clusterGenesisHash: bytesField(entry, "cluster_genesis_hash"),
    covenant: bytesField(entry, "covenant"),
    circleEpoch: bigintField(entry, "circle_epoch"),
    policyId: bytesField(entry, "policy_id"),
    actionCategory: field(entry, "action_category") as ActionTemplate["actionCategory"],
    adapterProgramId: bytesField(entry, "adapter_program_id"),
    adapterVersion: numberField(entry, "adapter_version"),
    adapterCapability: bytesField(entry, "adapter_capability"),
    targetProgramId: bytesField(entry, "target_program_id"),
    instructionDiscriminator: bytesField(entry, "instruction_discriminator"),
    accountMetas: list(entry, "account_metas").map((meta) => ({
      role: str(meta, "role") as ActionTemplate["accountMetas"][number]["role"],
      pubkey: fromHex(str(meta, "pubkey")),
      isSigner: flag(meta, "is_signer"),
      isWritable: flag(meta, "is_writable"),
    })),
    instructionData: bytesField(entry, "instruction_data"),
    effectLimit: effectLimitFrom(entry.fields),
  };
}

function rebuildMember(entry: VectorEntry): Member {
  return {
    domain: bytesField(entry, "domain"),
    member: bytesField(entry, "member"),
    role: field(entry, "role") as Member["role"],
    adapterCapability: bytesField(entry, "adapter_capability"),
    adapterVersion: numberField(entry, "adapter_version"),
  };
}

function rebuildPolicy(entry: VectorEntry): ResponsePolicy {
  const roles = entry.fields.required_roles;
  if (!Array.isArray(roles)) {
    throw new Error("policy.required_roles is not an array");
  }
  return {
    domain: bytesField(entry, "domain"),
    policyId: bytesField(entry, "policy_id"),
    actionCategory: field(entry, "action_category") as ResponsePolicy["actionCategory"],
    dependencyNamespace: field(
      entry,
      "dependency_namespace",
    ) as ResponsePolicy["dependencyNamespace"],
    dependencyId: bytesField(entry, "dependency_id"),
    eligibleMemberSetHash: bytesField(entry, "eligible_member_set_hash"),
    requiredApprovals: numberField(entry, "required_approvals"),
    maximumRejections: numberField(entry, "maximum_rejections"),
    requiredRoles: roles as ResponsePolicy["requiredRoles"],
    responseWindowSlots: bigintField(entry, "response_window_slots"),
    certificateTtlSlots: bigintField(entry, "certificate_ttl_slots"),
    actionBundleTemplateHash: bytesField(entry, "action_bundle_template_hash"),
    version: numberField(entry, "version"),
  };
}

function rebuildCertificate(entry: VectorEntry): Certificate {
  return {
    domain: bytesField(entry, "domain"),
    clusterGenesisHash: bytesField(entry, "cluster_genesis_hash"),
    covenant: bytesField(entry, "covenant"),
    circleEpoch: bigintField(entry, "circle_epoch"),
    incidentId: bigintField(entry, "incident_id"),
    policyId: bytesField(entry, "policy_id"),
    memberSetHash: bytesField(entry, "member_set_hash"),
    actionBundleHash: bytesField(entry, "action_bundle_hash"),
    operationId: bytesField(entry, "operation_id"),
    certificateNonce: bigintField(entry, "certificate_nonce"),
    approvalCount: numberField(entry, "approval_count"),
    rejectionCount: numberField(entry, "rejection_count"),
    certifiedAtSlot: bigintField(entry, "certified_at_slot"),
    expiresAtSlot: bigintField(entry, "expires_at_slot"),
  };
}

function rebuildCovenantDigest(entry: VectorEntry): CovenantDigest {
  return {
    domain: bytesField(entry, "domain"),
    clusterGenesisHash: bytesField(entry, "cluster_genesis_hash"),
    covenant: bytesField(entry, "covenant"),
    circleEpoch: bigintField(entry, "circle_epoch"),
    steward: bytesField(entry, "steward"),
    memberSetHash: bytesField(entry, "member_set_hash"),
    policiesHash: bytesField(entry, "policies_hash"),
    adapterSetHash: bytesField(entry, "adapter_set_hash"),
    validFromSlot: bigintField(entry, "valid_from_slot"),
    expiresAtSlot: bigintField(entry, "expires_at_slot"),
  };
}

function rebuildAttestation(entry: VectorEntry): Attestation {
  return {
    domain: bytesField(entry, "domain"),
    covenant: bytesField(entry, "covenant"),
    circleEpoch: bigintField(entry, "circle_epoch"),
    incidentId: bigintField(entry, "incident_id"),
    member: bytesField(entry, "member"),
    decision: field(entry, "decision") as Attestation["decision"],
    submissionNonce: bigintField(entry, "submission_nonce"),
    submittedAtSlot: bigintField(entry, "submitted_at_slot"),
    state: field(entry, "state") as Attestation["state"],
  };
}

function rebuildIncidentClaim(entry: VectorEntry): IncidentClaim {
  return {
    domain: bytesField(entry, "domain"),
    dependencyNamespace: field(
      entry,
      "dependency_namespace",
    ) as IncidentClaim["dependencyNamespace"],
    dependencyId: bytesField(entry, "dependency_id"),
    observationWindowStart: bigintField(entry, "observation_window_start"),
    observationWindowEnd: bigintField(entry, "observation_window_end"),
    claimSchemaHash: bytesField(entry, "claim_schema_hash"),
    privateEvidenceDigest: bytesField(entry, "private_evidence_digest"),
    signalCategory: field(entry, "signal_category") as IncidentClaim["signalCategory"],
    confidenceBucket: field(entry, "confidence_bucket") as IncidentClaim["confidenceBucket"],
    requestedActionCategory: field(
      entry,
      "requested_action_category",
    ) as IncidentClaim["requestedActionCategory"],
    submitter: bytesField(entry, "submitter"),
    submissionNonce: bigintField(entry, "submission_nonce"),
  };
}

/** Runs every parity check and returns the failures. */
export function verifyVectors(vectors: CanonicalVectors): ParityFailure[] {
  const failures: ParityFailure[] = [];

  const check = (entry: string, name: string, expected: string, actual: string): void => {
    if (expected !== actual) {
      failures.push({ entry, check: name, expected, actual });
    }
  };

  /** Digest consistency plus independent re-encoding. */
  const checkEntry = (entry: VectorEntry, reencode: () => Uint8Array): void => {
    const recorded = fromHex(entry.borsh_hex);
    check(entry.name, "sha256(preimage)", entry.sha256, toHex(sha256(recorded)));
    check(entry.name, "borsh_len", String(entry.borsh_len), String(recorded.length));
    const rebuilt = reencode();
    check(entry.name, "independent encoding", entry.borsh_hex, toHex(rebuilt));
    check(entry.name, "independent digest", entry.sha256, toHex(sha256(rebuilt)));
  };

  // Domain separators.
  for (const record of vectors.domains) {
    check(`domain:${record.label}`, "sha256(label)", record.sha256, toHex(domain(record.label)));
  }

  // Members and the member-set commitment.
  const memberDigests: Uint8Array[] = [];
  for (const entry of vectors.members.entries) {
    checkEntry(entry, () => encodeMember(rebuildMember(entry)));
    memberDigests.push(fromHex(entry.sha256));
  }
  check(
    "member_set",
    "member_set_hash",
    vectors.members.member_set_hash,
    toHex(hashDigestList(domain(DOMAINS.MEMBER_SET_V1), memberDigests)),
  );

  // Policy and the policy-set commitment.
  checkEntry(vectors.policy, () => encodeResponsePolicy(rebuildPolicy(vectors.policy)));
  check(
    "policies",
    "policies_hash",
    vectors.policies_hash,
    toHex(hashDigestList(domain(DOMAINS.POLICY_SET_V1), [fromHex(vectors.policy.sha256)])),
  );

  // Action templates and the registered bundle template.
  const templates: ActionTemplate[] = [];
  for (const entry of vectors.action_templates) {
    const template = rebuildActionTemplate(entry);
    checkEntry(entry, () => {
      const writer = encodeActionBundleTemplate([template]);
      // Strip the vector length prefix to compare a single template.
      return writer.slice(4);
    });
    templates.push(template);
  }
  checkEntry(vectors.bundle_template, () => encodeActionBundleTemplate(templates));
  check(
    "bundle_template",
    "bundle_template_hash",
    vectors.bundle_template_hash,
    vectors.bundle_template.sha256,
  );

  // The operation ID, derived from the template hash and never from the concrete bundle.
  const operationInputs = vectors.operation_id.inputs;
  const derivedOperation = operationId({
    clusterGenesisHash: fromHex(operationInputs.cluster_genesis_hash as string),
    covenant: fromHex(operationInputs.covenant as string),
    circleEpoch: BigInt(operationInputs.circle_epoch as string),
    incidentId: BigInt(operationInputs.incident_id as string),
    policyId: fromHex(operationInputs.policy_id as string),
    memberSetHash: fromHex(operationInputs.member_set_hash as string),
    actionBundleTemplateHash: fromHex(operationInputs.action_bundle_template_hash as string),
    certificateNonce: BigInt(operationInputs.certificate_nonce as string),
  });
  check("operation_id", "derivation", vectors.operation_id.sha256, toHex(derivedOperation));
  check(
    "operation_id",
    "matches the template hash the policy commits to",
    vectors.bundle_template_hash,
    operationInputs.action_bundle_template_hash as string,
  );

  // The concrete bundle.
  const bundle = rebuildActionBundle(vectors.action_bundle);
  checkEntry(vectors.action_bundle, () => encodeActionBundle(bundle));
  check(
    "action_bundle",
    "carries the derived operation id",
    vectors.operation_id.sha256,
    toHex(bundle.operationId),
  );

  // Account-meta order survives a decode/encode round trip untouched.
  const decoded = decodeActionBundle(fromHex(vectors.action_bundle.borsh_hex));
  for (const [actionIndex, action] of decoded.actions.entries()) {
    const source = bundle.actions[actionIndex];
    if (source === undefined) {
      failures.push({
        entry: "action_bundle",
        check: `action ${actionIndex} present`,
        expected: "present",
        actual: "missing",
      });
      continue;
    }
    for (const [metaIndex, meta] of action.accountMetas.entries()) {
      const expected = source.accountMetas[metaIndex];
      if (expected === undefined || !bytesEqual(meta.pubkey, expected.pubkey)) {
        failures.push({
          entry: "action_bundle",
          check: `action ${actionIndex} meta ${metaIndex} order`,
          expected: expected ? toHex(expected.pubkey) : "missing",
          actual: toHex(meta.pubkey),
        });
      }
    }
  }

  // Mutations. These carry no structured fields, so the check is a decode/re-encode round
  // trip plus the digest. It still exercises this package's codec on every mutated shape,
  // including the sorted and swapped account-meta cases.
  const baselineDigest = vectors.action_bundle.sha256;
  const seen = new Set<string>([baselineDigest]);
  for (const mutation of vectors.action_bundle_mutations) {
    if (mutation.rejected) {
      if (!mutation.reason) {
        failures.push({
          entry: `mutation:${mutation.mutation}`,
          check: "rejected entries carry a reason",
          expected: "a reason",
          actual: "none",
        });
      }
      continue;
    }
    if (!mutation.borsh_hex || !mutation.sha256) {
      failures.push({
        entry: `mutation:${mutation.mutation}`,
        check: "accepted entries carry a preimage and digest",
        expected: "both",
        actual: "missing",
      });
      continue;
    }
    const bytes = fromHex(mutation.borsh_hex);
    check(`mutation:${mutation.mutation}`, "sha256", mutation.sha256, toHex(sha256(bytes)));
    const roundTripped = encodeActionBundle(decodeActionBundle(bytes));
    check(
      `mutation:${mutation.mutation}`,
      "decode/encode round trip",
      mutation.borsh_hex,
      toHex(roundTripped),
    );
    if (mutation.sha256 === baselineDigest) {
      failures.push({
        entry: `mutation:${mutation.mutation}`,
        check: "changes the digest",
        expected: `not ${baselineDigest}`,
        actual: mutation.sha256,
      });
    }
    if (seen.has(mutation.sha256)) {
      failures.push({
        entry: `mutation:${mutation.mutation}`,
        check: "produces a distinct digest",
        expected: "unseen digest",
        actual: mutation.sha256,
      });
    }
    seen.add(mutation.sha256);
  }

  // Remaining structures.
  checkEntry(vectors.certificate, () => encodeCertificate(rebuildCertificate(vectors.certificate)));
  check(
    "certificate",
    "binds the concrete bundle",
    vectors.action_bundle.sha256,
    (vectors.certificate.fields.action_bundle_hash as string) ?? "",
  );
  check(
    "certificate",
    "binds the operation",
    vectors.operation_id.sha256,
    (vectors.certificate.fields.operation_id as string) ?? "",
  );

  checkEntry(vectors.covenant_digest, () =>
    encodeCovenantDigest(rebuildCovenantDigest(vectors.covenant_digest)),
  );
  checkEntry(vectors.attestation, () => encodeAttestation(rebuildAttestation(vectors.attestation)));
  checkEntry(vectors.incident_claim, () =>
    encodeIncidentClaim(rebuildIncidentClaim(vectors.incident_claim)),
  );

  // Recovery identity.
  const recoveryInputs = vectors.recovery_operation_id.inputs;
  const derivedRecovery = recoveryOperationId(
    fromHex(recoveryInputs.original_operation_id as string),
    fromHex(recoveryInputs.covenant as string),
    BigInt(recoveryInputs.circle_epoch as string),
    BigInt(recoveryInputs.incident_id as string),
    BigInt(recoveryInputs.recovery_nonce as string),
  );
  check(
    "recovery_operation_id",
    "derivation",
    vectors.recovery_operation_id.sha256,
    toHex(derivedRecovery),
  );
  if (vectors.recovery_operation_id.sha256 === vectors.operation_id.sha256) {
    failures.push({
      entry: "recovery_operation_id",
      check: "differs from the original operation",
      expected: "a different digest",
      actual: vectors.recovery_operation_id.sha256,
    });
  }

  return failures;
}

/** Recomputes the adapter-set commitment for a set of capabilities. */
export { adapterSetHash };

/** Confirms the template decoder agrees with the encoder for the registered bundle. */
export function templateRoundTrips(vectors: CanonicalVectors): boolean {
  const bytes = fromHex(vectors.bundle_template.borsh_hex);
  return bytesEqual(encodeActionBundleTemplate(decodeActionBundleTemplate(bytes)), bytes);
}

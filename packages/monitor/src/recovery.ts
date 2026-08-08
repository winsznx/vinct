/**
 * The recovery registry.
 *
 * A cohort that did not deliver is not retried. It is replaced, under a new operation ID
 * derived from a fresh nonce, after the approvals the covenant requires. An adapter that
 * already consumed the original still refuses it, and one that has not will accept exactly one
 * of the two, which is what makes the replacement safe without a distributed lock.
 *
 * Mirrors `crates/vinct-types/src/recovery.rs` and `crates/vinct-reference/src/recover.rs`. The
 * recovery operation ID is checked against the Rust vector in
 * `tests/program/settlement-monitor.test.ts`.
 */

import { permitsRecovery, SettlementClassification } from "./classify.js";
import type { SettlementRecord } from "./record.js";
import { sha256 as sha256Bytes } from "../../client/src/sha256.js";

/** Where a recovery proposal sits. */
export enum RecoveryStatus {
  Proposed = "Proposed",
  Approved = "Approved",
  Scheduled = "Scheduled",
  Completed = "Completed",
  Expired = "Expired",
  Abandoned = "Abandoned",
}

/** Why a recovery proposal was refused. */
export enum RecoveryRefusal {
  ClassificationBlocksRecovery = "ClassificationBlocksRecovery",
  ReusedOperationId = "ReusedOperationId",
  ReusedCertificateNonce = "ReusedCertificateNonce",
  MissingEffectNotInOriginal = "MissingEffectNotInOriginal",
  NothingToRecover = "NothingToRecover",
  Expired = "Expired",
  CategoryBroadened = "CategoryBroadened",
  DuplicateRecovery = "DuplicateRecovery",
}

export class RecoveryRefused extends Error {
  constructor(readonly refusal: RecoveryRefusal) {
    super(`recovery refused: ${refusal}`);
    this.name = "RecoveryRefused";
  }
}

export interface RecoveryProposalInputs {
  originalOperationId: Uint8Array;
  /** Kept as immutable evidence of what was certified. */
  originalCertificateHash: Uint8Array;
  covenant: Uint8Array;
  circleEpoch: bigint;
  incidentId: bigint;
  /** A nonce used by neither the original operation nor an earlier recovery. */
  recoveryNonce: bigint;
  /** The original certificate's nonce, so reuse can be refused. */
  originalCertificateNonce: bigint;
  expiresAtSlot: bigint;
  requiredApprovals: number;
}

export interface RecoveryOperation {
  originalOperationId: string;
  originalCertificateHash: string;
  covenant: string;
  circleEpoch: string;
  incidentId: string;
  /** Derived from the observations, never supplied by the caller. */
  missingActionIndices: number[];
  recoveryNonce: string;
  recoveryOperationId: string;
  expiresAtSlot: string;
  requiredApprovals: number;
  approvalCount: number;
  status: RecoveryStatus;
}

const RECOVERY_DOMAIN = "VINCT_RECOVERY_V1";

function sha256(input: Buffer): Buffer {
  return sha256Bytes(input);
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

/**
 * Derives a recovery's operation ID.
 *
 * Domain-separated from the ordinary operation ID, so a recovery identity cannot collide with a
 * primary one even if every other input happened to match.
 */
export function recoveryOperationId(
  originalOperationId: Uint8Array,
  covenant: Uint8Array,
  circleEpoch: bigint,
  incidentId: bigint,
  recoveryNonce: bigint,
): Uint8Array {
  return new Uint8Array(
    sha256(
      Buffer.concat([
        sha256(Buffer.from(RECOVERY_DOMAIN, "utf8")),
        Buffer.from(originalOperationId),
        Buffer.from(covenant),
        u64(circleEpoch),
        u64(incidentId),
        u64(recoveryNonce),
      ]),
    ),
  );
}

/**
 * Builds a recovery proposal from a settlement record.
 *
 * The missing action list comes from the record's observations. A caller that could name which
 * effects were missing could name one that actually applied, and a duplicate pause is exactly
 * the failure a bounded action exists to prevent.
 *
 * Only `CommitWithoutActions` permits recovery. `PartialObservation` blocks it: a cohort that
 * half-applied means an assumption about transaction-strategy grouping was wrong, and
 * automating a retry before someone understands why is how a bounded action becomes unbounded.
 */
export function proposeRecovery(
  record: SettlementRecord,
  inputs: RecoveryProposalInputs,
  existingRecoveries: RecoveryOperation[],
  nowSlot: bigint,
): RecoveryOperation {
  const originalHex = Buffer.from(inputs.originalOperationId).toString("hex");

  if (!permitsRecovery(record.classification)) {
    throw new RecoveryRefused(RecoveryRefusal.ClassificationBlocksRecovery);
  }
  if (record.operationId !== originalHex) {
    throw new RecoveryRefused(RecoveryRefusal.MissingEffectNotInOriginal);
  }
  if (nowSlot >= inputs.expiresAtSlot) {
    throw new RecoveryRefused(RecoveryRefusal.Expired);
  }
  if (inputs.recoveryNonce === inputs.originalCertificateNonce) {
    throw new RecoveryRefused(RecoveryRefusal.ReusedCertificateNonce);
  }
  if (existingRecoveries.some((r) => r.originalOperationId === originalHex)) {
    throw new RecoveryRefused(RecoveryRefusal.DuplicateRecovery);
  }
  if (record.missingActionIndices.length === 0) {
    throw new RecoveryRefused(RecoveryRefusal.NothingToRecover);
  }

  const recoveryId = recoveryOperationId(
    inputs.originalOperationId,
    inputs.covenant,
    inputs.circleEpoch,
    inputs.incidentId,
    inputs.recoveryNonce,
  );
  if (Buffer.from(recoveryId).equals(Buffer.from(inputs.originalOperationId))) {
    throw new RecoveryRefused(RecoveryRefusal.ReusedOperationId);
  }

  return {
    originalOperationId: originalHex,
    originalCertificateHash: Buffer.from(inputs.originalCertificateHash).toString("hex"),
    covenant: Buffer.from(inputs.covenant).toString("hex"),
    circleEpoch: inputs.circleEpoch.toString(),
    incidentId: inputs.incidentId.toString(),
    missingActionIndices: [...record.missingActionIndices],
    recoveryNonce: inputs.recoveryNonce.toString(),
    recoveryOperationId: Buffer.from(recoveryId).toString("hex"),
    expiresAtSlot: inputs.expiresAtSlot.toString(),
    requiredApprovals: inputs.requiredApprovals,
    approvalCount: 0,
    status: RecoveryStatus.Proposed,
  };
}

/**
 * Why a record did not produce a proposal, in a form a runbook can act on.
 *
 * Separate from `proposeRecovery` because "no recovery" is the normal outcome and should not be
 * reached by catching an exception.
 */
export function recoveryVerdict(record: SettlementRecord): string {
  switch (record.classification) {
    case SettlementClassification.AllActionsApplied:
      return "settled; nothing to recover";
    case SettlementClassification.CommitWithoutActions:
      return `recoverable under a new operation ID; missing actions ${record.missingActionIndices.join(", ")}`;
    case SettlementClassification.PartialObservation:
      return "blocked; a cohort that half-applied is a critical invariant failure and needs a human before any retry";
    case SettlementClassification.Unknown:
      return "blocked; evidence is insufficient to classify, so nothing may be replaced yet";
  }
}

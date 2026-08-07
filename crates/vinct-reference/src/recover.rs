//! Governed recovery proposals.

use vinct_types::address::Address;
use vinct_types::hash::Digest32;
use vinct_types::recovery::{
    recovery_operation_id, RecoveryOperationV1, RecoveryRefusal, RecoveryStatus,
};
use vinct_types::settlement::{
    permits_recovery, SettlementClassification, SettlementObservationV1,
};

use vinct_types::domains;
use vinct_types::hash::domain;

/// Everything needed to propose a recovery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryProposalInputs {
    /// The operation that failed to deliver.
    pub original_operation_id: Digest32,
    /// The original certificate's hash, kept as immutable evidence.
    pub original_certificate_hash: Digest32,
    /// The covenant.
    pub covenant: Address,
    /// The frozen epoch.
    pub circle_epoch: u64,
    /// The incident.
    pub incident_id: u64,
    /// A nonce never used by the original operation or an earlier recovery.
    pub recovery_nonce: u64,
    /// The original certificate's nonce, so reuse can be refused.
    pub original_certificate_nonce: u64,
    /// Slot after which the recovery may no longer be attempted.
    pub expires_at_slot: u64,
    /// Human approvals required before it may be scheduled.
    pub required_approvals: u8,
}

/// Builds a recovery proposal from a classification and its observations.
///
/// The missing action list is derived from the observations rather than supplied by the
/// caller. A caller that could name which effects were missing could name one that was
/// actually applied and cause a duplicate pause.
///
/// Only [`SettlementClassification::CommitWithoutActions`] permits recovery.
/// `PartialObservation` blocks it: a cohort that half-applied means the transaction
/// strategy did not behave as assumed, and automating a retry before a human understands
/// why is how a bounded action becomes an unbounded one.
pub fn propose_recovery(
    classification: SettlementClassification,
    observation: &SettlementObservationV1,
    inputs: &RecoveryProposalInputs,
    existing_recoveries: &[RecoveryOperationV1],
    now_slot: u64,
) -> Result<RecoveryOperationV1, RecoveryRefusal> {
    if !permits_recovery(classification) {
        return Err(RecoveryRefusal::ClassificationBlocksRecovery);
    }
    if observation.operation_id != inputs.original_operation_id {
        return Err(RecoveryRefusal::MissingEffectNotInOriginal);
    }
    if now_slot >= inputs.expires_at_slot {
        return Err(RecoveryRefusal::Expired);
    }
    if inputs.recovery_nonce == inputs.original_certificate_nonce {
        return Err(RecoveryRefusal::ReusedCertificateNonce);
    }
    if existing_recoveries
        .iter()
        .any(|r| r.original_operation_id == inputs.original_operation_id)
    {
        return Err(RecoveryRefusal::DuplicateRecovery);
    }

    let missing_action_indices: Vec<u16> = observation
        .actions
        .iter()
        .filter(|a| a.is_absent())
        .map(|a| a.action_index)
        .collect();
    if missing_action_indices.is_empty() {
        return Err(RecoveryRefusal::NothingToRecover);
    }

    let recovery_id = recovery_operation_id(
        &inputs.original_operation_id,
        &inputs.covenant,
        inputs.circle_epoch,
        inputs.incident_id,
        inputs.recovery_nonce,
    );
    if recovery_id == inputs.original_operation_id {
        return Err(RecoveryRefusal::ReusedOperationId);
    }

    Ok(RecoveryOperationV1 {
        domain: domain(domains::RECOVERY_V1),
        original_operation_id: inputs.original_operation_id,
        original_certificate_hash: inputs.original_certificate_hash,
        covenant: inputs.covenant,
        circle_epoch: inputs.circle_epoch,
        incident_id: inputs.incident_id,
        missing_action_indices,
        recovery_nonce: inputs.recovery_nonce,
        recovery_operation_id: recovery_id,
        expires_at_slot: inputs.expires_at_slot,
        required_approvals: inputs.required_approvals,
        approval_count: 0,
        status: RecoveryStatus::Proposed,
    })
}

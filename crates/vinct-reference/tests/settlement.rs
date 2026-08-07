//! Settlement classification and recovery.
//!
//! The whole point of this module is that a scheduling signature proves nothing about
//! delivery. Every test here starts from observations of base-layer state and asserts
//! that VINCT reaches the honest conclusion, including the conclusions that say "I do not
//! know".

use vinct_reference::fixtures::*;
use vinct_reference::recover::*;
use vinct_types::hash::sha256;
use vinct_types::incident::IncidentStatus;
use vinct_types::recovery::{RecoveryRefusal, RecoveryStatus};
use vinct_types::settlement::*;

fn action(index: u16, receipt: ObservationV1, effect: ObservationV1) -> ActionObservationV1 {
    ActionObservationV1 {
        action_index: index,
        receipt,
        target_effect: effect,
        delivery_state: ActionDeliveryState::AttemptObserved,
    }
}

fn observation(
    checkpoint: ObservationV1,
    settlement: ObservationV1,
    actions: Vec<ActionObservationV1>,
) -> SettlementObservationV1 {
    SettlementObservationV1 {
        operation_id: sha256(b"operation"),
        certificate_checkpoint: checkpoint,
        settlement_receipt: settlement,
        actions,
    }
}

// ------------------------------------------------------------ the success path

#[test]
fn every_effect_observed_is_all_actions_applied() {
    let all = observation(
        ObservationV1::Present,
        ObservationV1::Present,
        vec![
            action(0, ObservationV1::Present, ObservationV1::Present),
            action(1, ObservationV1::Present, ObservationV1::Present),
            action(2, ObservationV1::Present, ObservationV1::Present),
        ],
    );
    assert_eq!(classify(&all), SettlementClassification::AllActionsApplied);
    assert_eq!(
        status_for(SettlementClassification::AllActionsApplied),
        IncidentStatus::Settled
    );
}

#[test]
fn a_receipt_without_the_target_effect_is_not_applied() {
    // An adapter that wrote a receipt but whose CPI did not change the protocol's state
    // has not delivered. Trusting the receipt alone would let a broken adapter report
    // success.
    let receipt_only = observation(
        ObservationV1::Present,
        ObservationV1::Present,
        vec![
            action(0, ObservationV1::Present, ObservationV1::Absent),
            action(1, ObservationV1::Present, ObservationV1::Present),
            action(2, ObservationV1::Present, ObservationV1::Present),
        ],
    );
    assert_ne!(
        classify(&receipt_only),
        SettlementClassification::AllActionsApplied
    );
    assert_eq!(
        classify(&receipt_only),
        SettlementClassification::PartialObservation
    );
}

#[test]
fn a_missing_settlement_receipt_blocks_settled() {
    let no_final = observation(
        ObservationV1::Present,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::Present, ObservationV1::Present),
            action(1, ObservationV1::Present, ObservationV1::Present),
            action(2, ObservationV1::Present, ObservationV1::Present),
        ],
    );
    assert_eq!(
        classify(&no_final),
        SettlementClassification::PartialObservation
    );
    assert_ne!(status_for(classify(&no_final)), IncidentStatus::Settled);
}

// ------------------------------------------------------ commit without actions

#[test]
fn checkpoint_landed_and_nothing_else_is_commit_without_actions() {
    let stripped = observation(
        ObservationV1::Present,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::Absent, ObservationV1::Absent),
            action(1, ObservationV1::Absent, ObservationV1::Absent),
            action(2, ObservationV1::Absent, ObservationV1::Absent),
        ],
    );
    assert_eq!(
        classify(&stripped),
        SettlementClassification::CommitWithoutActions
    );
    assert_eq!(
        status_for(SettlementClassification::CommitWithoutActions),
        IncidentStatus::CommitWithoutActions
    );
    assert!(permits_recovery(
        SettlementClassification::CommitWithoutActions
    ));
}

#[test]
fn nothing_landed_at_all_is_not_commit_without_actions() {
    // If even the checkpoint is missing, the committor may simply not have run yet.
    // Calling that `CommitWithoutActions` would open a recovery against an operation that
    // is still in flight.
    let nothing = observation(
        ObservationV1::Absent,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::Absent, ObservationV1::Absent),
            action(1, ObservationV1::Absent, ObservationV1::Absent),
        ],
    );
    assert_eq!(classify(&nothing), SettlementClassification::Unknown);
    assert!(!permits_recovery(SettlementClassification::Unknown));
}

// ------------------------------------------------------------------- partial

#[test]
fn a_half_applied_cohort_is_a_partial_observation() {
    let half = observation(
        ObservationV1::Present,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::Present, ObservationV1::Present),
            action(1, ObservationV1::Absent, ObservationV1::Absent),
            action(2, ObservationV1::Absent, ObservationV1::Absent),
        ],
    );
    assert_eq!(
        classify(&half),
        SettlementClassification::PartialObservation
    );
    assert_eq!(
        status_for(SettlementClassification::PartialObservation),
        IncidentStatus::ReconciliationRequired
    );
}

#[test]
fn a_partial_observation_blocks_automated_recovery() {
    // One intended cohort should share one transaction outcome. A cohort that half-applied
    // means the transaction-strategy assumption was wrong, and retrying anything before a
    // human understands why risks a duplicate effect.
    assert!(!permits_recovery(
        SettlementClassification::PartialObservation
    ));
}

// ------------------------------------------------------------------- unknown

#[test]
fn an_unreadable_action_is_unknown_not_absent() {
    let rpc_gap = observation(
        ObservationV1::Present,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::NotObserved, ObservationV1::NotObserved),
            action(1, ObservationV1::Absent, ObservationV1::Absent),
        ],
    );
    assert_eq!(classify(&rpc_gap), SettlementClassification::Unknown);
    assert_eq!(
        status_for(SettlementClassification::Unknown),
        IncidentStatus::SettlementUnknown
    );
}

#[test]
fn an_unreadable_checkpoint_is_unknown() {
    let rpc_gap = observation(
        ObservationV1::NotObserved,
        ObservationV1::Absent,
        vec![action(0, ObservationV1::Absent, ObservationV1::Absent)],
    );
    assert_eq!(classify(&rpc_gap), SettlementClassification::Unknown);
}

#[test]
fn an_unreadable_settlement_receipt_is_unknown_even_when_actions_applied() {
    let rpc_gap = observation(
        ObservationV1::Present,
        ObservationV1::NotObserved,
        vec![action(0, ObservationV1::Present, ObservationV1::Present)],
    );
    assert_eq!(classify(&rpc_gap), SettlementClassification::Unknown);
}

#[test]
fn an_empty_observation_is_unknown() {
    let empty = observation(ObservationV1::Present, ObservationV1::Present, vec![]);
    assert_eq!(classify(&empty), SettlementClassification::Unknown);
}

#[test]
fn only_all_actions_applied_reaches_settled() {
    for classification in [
        SettlementClassification::AllActionsApplied,
        SettlementClassification::CommitWithoutActions,
        SettlementClassification::PartialObservation,
        SettlementClassification::Unknown,
    ] {
        let status = status_for(classification);
        let reaches_settled = status == IncidentStatus::Settled;
        assert_eq!(
            reaches_settled,
            classification == SettlementClassification::AllActionsApplied,
            "{classification:?} mapped to {status:?}"
        );
    }
}

// ------------------------------------------------------------------ recovery

fn recovery_inputs() -> RecoveryProposalInputs {
    RecoveryProposalInputs {
        original_operation_id: sha256(b"operation"),
        original_certificate_hash: sha256(b"certificate"),
        covenant: COVENANT,
        circle_epoch: 1,
        incident_id: 7,
        recovery_nonce: 99,
        original_certificate_nonce: CERTIFICATE_NONCE,
        expires_at_slot: 5_000,
        required_approvals: 2,
    }
}

fn stripped_observation() -> SettlementObservationV1 {
    observation(
        ObservationV1::Present,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::Absent, ObservationV1::Absent),
            action(1, ObservationV1::Absent, ObservationV1::Absent),
            action(2, ObservationV1::Absent, ObservationV1::Absent),
        ],
    )
}

#[test]
fn recovery_gets_a_fresh_operation_id() {
    let proposal = propose_recovery(
        SettlementClassification::CommitWithoutActions,
        &stripped_observation(),
        &recovery_inputs(),
        &[],
        1_000,
    )
    .expect("proposes");
    assert_ne!(
        proposal.recovery_operation_id, proposal.original_operation_id,
        "recovery reused the original operation id"
    );
    assert_eq!(proposal.status, RecoveryStatus::Proposed);
    assert_eq!(proposal.approval_count, 0);
    assert_eq!(proposal.missing_action_indices, vec![0, 1, 2]);
}

#[test]
fn the_original_operation_is_retained_unchanged() {
    let inputs = recovery_inputs();
    let proposal = propose_recovery(
        SettlementClassification::CommitWithoutActions,
        &stripped_observation(),
        &inputs,
        &[],
        1_000,
    )
    .expect("proposes");
    assert_eq!(proposal.original_operation_id, inputs.original_operation_id);
    assert_eq!(
        proposal.original_certificate_hash,
        inputs.original_certificate_hash
    );
}

#[test]
fn a_different_recovery_nonce_produces_a_different_recovery_id() {
    let first = propose_recovery(
        SettlementClassification::CommitWithoutActions,
        &stripped_observation(),
        &recovery_inputs(),
        &[],
        1_000,
    )
    .expect("proposes");
    let mut other_inputs = recovery_inputs();
    other_inputs.recovery_nonce = 100;
    let second = propose_recovery(
        SettlementClassification::CommitWithoutActions,
        &stripped_observation(),
        &other_inputs,
        &[],
        1_000,
    )
    .expect("proposes");
    assert_ne!(first.recovery_operation_id, second.recovery_operation_id);
}

#[test]
fn recovery_is_refused_for_a_partial_observation() {
    let half = observation(
        ObservationV1::Present,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::Present, ObservationV1::Present),
            action(1, ObservationV1::Absent, ObservationV1::Absent),
        ],
    );
    assert_eq!(
        propose_recovery(
            SettlementClassification::PartialObservation,
            &half,
            &recovery_inputs(),
            &[],
            1_000,
        )
        .unwrap_err(),
        RecoveryRefusal::ClassificationBlocksRecovery
    );
}

#[test]
fn recovery_is_refused_when_nothing_is_missing() {
    let all_applied = observation(
        ObservationV1::Present,
        ObservationV1::Present,
        vec![action(0, ObservationV1::Present, ObservationV1::Present)],
    );
    assert_eq!(
        propose_recovery(
            SettlementClassification::CommitWithoutActions,
            &all_applied,
            &recovery_inputs(),
            &[],
            1_000,
        )
        .unwrap_err(),
        RecoveryRefusal::NothingToRecover
    );
}

#[test]
fn recovery_is_refused_after_its_window_closes() {
    assert_eq!(
        propose_recovery(
            SettlementClassification::CommitWithoutActions,
            &stripped_observation(),
            &recovery_inputs(),
            &[],
            5_000,
        )
        .unwrap_err(),
        RecoveryRefusal::Expired
    );
}

#[test]
fn recovery_is_refused_when_it_reuses_the_certificate_nonce() {
    let mut inputs = recovery_inputs();
    inputs.recovery_nonce = CERTIFICATE_NONCE;
    assert_eq!(
        propose_recovery(
            SettlementClassification::CommitWithoutActions,
            &stripped_observation(),
            &inputs,
            &[],
            1_000,
        )
        .unwrap_err(),
        RecoveryRefusal::ReusedCertificateNonce
    );
}

#[test]
fn a_second_recovery_for_the_same_operation_is_refused() {
    let first = propose_recovery(
        SettlementClassification::CommitWithoutActions,
        &stripped_observation(),
        &recovery_inputs(),
        &[],
        1_000,
    )
    .expect("proposes");
    let mut inputs = recovery_inputs();
    inputs.recovery_nonce = 100;
    assert_eq!(
        propose_recovery(
            SettlementClassification::CommitWithoutActions,
            &stripped_observation(),
            &inputs,
            std::slice::from_ref(&first),
            1_000,
        )
        .unwrap_err(),
        RecoveryRefusal::DuplicateRecovery
    );
}

#[test]
fn recovery_is_refused_when_the_observation_is_for_another_operation() {
    let mut foreign = stripped_observation();
    foreign.operation_id = sha256(b"a different operation");
    assert_eq!(
        propose_recovery(
            SettlementClassification::CommitWithoutActions,
            &foreign,
            &recovery_inputs(),
            &[],
            1_000,
        )
        .unwrap_err(),
        RecoveryRefusal::MissingEffectNotInOriginal
    );
}

#[test]
fn recovery_only_names_effects_the_observer_positively_established_as_missing() {
    // An action the observer could not read is not proposed for recovery. Recovering an
    // action that actually applied would pause a protocol twice.
    let mixed = observation(
        ObservationV1::Present,
        ObservationV1::Absent,
        vec![
            action(0, ObservationV1::Absent, ObservationV1::Absent),
            action(1, ObservationV1::NotObserved, ObservationV1::NotObserved),
        ],
    );
    let proposal = propose_recovery(
        SettlementClassification::CommitWithoutActions,
        &mixed,
        &recovery_inputs(),
        &[],
        1_000,
    )
    .expect("proposes");
    assert_eq!(proposal.missing_action_indices, vec![0]);
}

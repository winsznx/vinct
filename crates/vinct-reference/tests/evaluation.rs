//! Every incident-evaluation case PRD section 22 requires.

use vinct_reference::evaluate::*;
use vinct_reference::fixtures::*;
use vinct_reference::model::*;
use vinct_types::attestation::{AttestationState, AttestationV1, Decision};
use vinct_types::covenant::{MemberRole, MemberSetV1, MemberV1};
use vinct_types::hash::sha256;
use vinct_types::incident::IncidentStatus;

const OPENED: u64 = 1_000;
const NOW: u64 = 1_100;

fn attest(member: vinct_types::Address, decision: Decision, nonce: u64) -> AttestationV1 {
    AttestationV1::new(COVENANT, 1, 7, member, decision, nonce, NOW)
}

fn open() -> (CovenantSnapshot, IncidentState) {
    (covenant_snapshot(), incident_state(7, OPENED))
}

// ------------------------------------------------------------ threshold cases

#[test]
fn no_attestations_is_collecting() {
    let (covenant, incident) = open();
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::Collecting);
    assert_eq!(result.tally.approvals, 0);
    assert_eq!(result.tally.eligible, 3);
    assert_eq!(result.tally.outstanding, 3);
}

#[test]
fn one_approval_is_below_the_threshold() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::Collecting);
    assert_eq!(result.tally.approvals, 1);
}

#[test]
fn threshold_reached_exactly_at_the_boundary_certifies() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_B, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::Certified);
    assert_eq!(result.tally.approvals, 2);
}

#[test]
fn a_third_approval_does_not_change_the_outcome() {
    let (covenant, mut incident) = open();
    for member in [PROTOCOL_A, PROTOCOL_B, PROTOCOL_C] {
        submit_attestation(
            &covenant,
            &mut incident,
            attest(member, Decision::Approve, 1),
            NOW,
        )
        .expect("accepted");
    }
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::Certified);
    assert_eq!(result.tally.approvals, 3);
}

#[test]
fn exceeding_the_rejection_ceiling_blocks_certification() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Reject, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_B, Decision::Reject, 1),
        NOW,
    )
    .expect("accepted");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::RejectedByThreshold);
}

#[test]
fn rejection_ceiling_wins_over_a_met_threshold() {
    // A three-member covenant cannot produce this, so the covenant is widened to four
    // members with a threshold of two and a ceiling of one. Two approvals and two
    // rejections then arrive together. The covenant agreed that enough objections stop
    // the action, so the objection has to win.
    let mut covenant = covenant_snapshot();
    let fourth = vinct_types::Address::from_seed(0xD1);
    covenant.member_set = MemberSetV1::new(vec![
        MemberV1::new(PROTOCOL_A, MemberRole::Protocol, CAPABILITY_A, 1),
        MemberV1::new(PROTOCOL_B, MemberRole::Protocol, CAPABILITY_B, 1),
        MemberV1::new(PROTOCOL_C, MemberRole::Protocol, CAPABILITY_C, 1),
        MemberV1::new(
            fourth,
            MemberRole::Protocol,
            vinct_types::Address::from_seed(0xD2),
            1,
        ),
    ])
    .expect("valid");
    covenant.policy.eligible_member_set_hash = covenant.member_set.hash().expect("hashes");

    let mut snapshot = incident_snapshot(7, OPENED);
    snapshot.member_set_hash = covenant.member_set.hash().expect("hashes");
    let mut incident = IncidentState::open(snapshot);

    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_B, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_C, Decision::Reject, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(fourth, Decision::Reject, 1),
        NOW,
    )
    .expect("accepted");

    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::RejectedByThreshold);
}

#[test]
fn abstentions_count_toward_neither_side() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Abstain, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_B, Decision::Abstain, 1),
        NOW,
    )
    .expect("accepted");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.tally.abstentions, 2);
    assert_eq!(result.tally.approvals, 0);
    assert_eq!(result.tally.rejections, 0);
    // One outstanding member cannot reach a threshold of two on their own.
    assert_eq!(result.outcome, EvaluationOutcome::Impossible);
}

// ------------------------------------------------------------- one vote rules

#[test]
fn one_member_contributes_at_most_one_effective_decision() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 2),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 3),
        NOW,
    )
    .expect("accepted");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(
        result.tally.approvals, 1,
        "one member produced more than one approval"
    );
    assert_eq!(
        incident.attestations.len(),
        3,
        "history should retain every submission"
    );
}

#[test]
fn replacement_before_certification_supersedes_the_earlier_decision() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Reject, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 2),
        NOW,
    )
    .expect("accepted");

    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.tally.approvals, 1);
    assert_eq!(result.tally.rejections, 0);
    assert_eq!(incident.attestations[0].state, AttestationState::Superseded);
    assert_eq!(incident.attestations[1].state, AttestationState::Submitted);
}

#[test]
fn a_duplicate_nonce_is_rejected() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(PROTOCOL_A, Decision::Reject, 1),
            NOW
        ),
        Err(EvaluationError::NonceNotIncreasing)
    );
}

#[test]
fn a_lower_nonce_is_rejected() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 5),
        NOW,
    )
    .expect("accepted");
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(PROTOCOL_A, Decision::Reject, 4),
            NOW
        ),
        Err(EvaluationError::NonceNotIncreasing)
    );
}

#[test]
fn a_superseded_nonce_cannot_be_replayed_after_a_later_submission() {
    // The nonce floor is the highest ever used, not the current effective one. Otherwise
    // superseding an attestation would free its nonce for reuse.
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Reject, 9),
        NOW,
    )
    .expect("accepted");
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(PROTOCOL_A, Decision::Approve, 5),
            NOW
        ),
        Err(EvaluationError::NonceNotIncreasing)
    );
}

// ------------------------------------------------------------- membership

#[test]
fn a_non_member_cannot_attest() {
    let (covenant, mut incident) = open();
    let outsider = vinct_types::Address::from_seed(0xFF);
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(outsider, Decision::Approve, 1),
            NOW
        ),
        Err(EvaluationError::NotAMember)
    );
}

#[test]
fn a_role_the_policy_excludes_cannot_attest() {
    let mut covenant = covenant_snapshot();
    let steward_member = MemberV1::new(STEWARD, MemberRole::Steward, vinct_types::Address::ZERO, 0);
    covenant.member_set = MemberSetV1::new(vec![
        MemberV1::new(PROTOCOL_A, MemberRole::Protocol, CAPABILITY_A, 1),
        MemberV1::new(PROTOCOL_B, MemberRole::Protocol, CAPABILITY_B, 1),
        MemberV1::new(PROTOCOL_C, MemberRole::Protocol, CAPABILITY_C, 1),
        steward_member,
    ])
    .expect("valid");

    let mut snapshot = incident_snapshot(7, OPENED);
    snapshot.member_set_hash = covenant.member_set.hash().expect("hashes");
    let mut incident = IncidentState::open(snapshot);

    // The fixture policy permits only the Protocol role, so a steward cannot vote itself
    // into an outcome even though it is a covenant member.
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(STEWARD, Decision::Approve, 1),
            NOW
        ),
        Err(EvaluationError::RoleMayNotAttest)
    );
}

#[test]
fn a_member_removed_in_a_future_epoch_still_decides_the_frozen_incident() {
    // The incident froze epoch 1. A covenant snapshot at epoch 2 that drops protocol C is
    // simply the wrong snapshot for this incident and is refused outright, rather than
    // silently changing an in-flight outcome.
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_C, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");

    let mut next_epoch = covenant_snapshot();
    next_epoch.circle_epoch = 2;
    next_epoch.member_set = MemberSetV1::new(vec![
        MemberV1::new(PROTOCOL_A, MemberRole::Protocol, CAPABILITY_A, 1),
        MemberV1::new(PROTOCOL_B, MemberRole::Protocol, CAPABILITY_B, 1),
    ])
    .expect("valid");

    assert_eq!(
        evaluate_incident(&next_epoch, &incident, NOW),
        Err(EvaluationError::StaleEpoch)
    );
    // The frozen snapshot still certifies.
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Certified
    );
}

#[test]
fn a_covenant_snapshot_with_a_different_member_set_is_refused() {
    let mut covenant = covenant_snapshot();
    let (_, incident) = open();
    covenant.member_set = MemberSetV1::new(vec![
        MemberV1::new(PROTOCOL_A, MemberRole::Protocol, CAPABILITY_A, 1),
        MemberV1::new(PROTOCOL_B, MemberRole::Protocol, CAPABILITY_B, 1),
    ])
    .expect("valid");
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW),
        Err(EvaluationError::MemberSetMismatch)
    );
}

#[test]
fn a_covenant_snapshot_with_a_different_policy_is_refused() {
    let mut covenant = covenant_snapshot();
    let (_, incident) = open();
    covenant.policy.policy_id = sha256(b"a different policy");
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW),
        Err(EvaluationError::PolicyMismatch)
    );
}

#[test]
fn a_covenant_snapshot_with_a_different_template_is_refused() {
    let mut covenant = covenant_snapshot();
    let (_, incident) = open();
    covenant.template = vinct_types::action::ActionBundleTemplateV1::new(vec![
        adapter_template(0, CAPABILITY_A, MARKET_A),
        adapter_template(1, CAPABILITY_B, MARKET_B),
    ])
    .expect("valid");
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW),
        Err(EvaluationError::TemplateMismatch)
    );
}

#[test]
fn a_cross_cluster_covenant_snapshot_is_refused() {
    let mut covenant = covenant_snapshot();
    let (_, incident) = open();
    covenant.cluster_genesis_hash = OTHER_CLUSTER;
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW),
        Err(EvaluationError::IncidentMismatch)
    );
}

// ------------------------------------------------------------------ quarantine

#[test]
fn quarantine_invalidates_the_members_attestation() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_B, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Certified
    );

    quarantine_member(&covenant, &mut incident, PROTOCOL_A).expect("quarantined");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(
        result.tally.approvals, 1,
        "quarantined approval still counted"
    );
    assert_eq!(
        incident.attestations[0].state,
        AttestationState::InvalidatedByQuarantine
    );
}

#[test]
fn quarantine_never_lowers_the_threshold() {
    let (covenant, mut incident) = open();
    quarantine_member(&covenant, &mut incident, PROTOCOL_A).expect("quarantined");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(incident.snapshot.required_approvals, 2, "threshold moved");
    assert_eq!(result.tally.eligible, 2);
    // Two eligible members remain and both must approve. The bar did not drop.
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_B, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Collecting
    );
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_C, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Certified
    );
}

#[test]
fn a_quarantined_member_cannot_submit() {
    let (covenant, mut incident) = open();
    quarantine_member(&covenant, &mut incident, PROTOCOL_A).expect("quarantined");
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(PROTOCOL_A, Decision::Approve, 1),
            NOW
        ),
        Err(EvaluationError::MemberQuarantined)
    );
}

#[test]
fn quarantining_two_of_three_makes_certification_impossible() {
    let (covenant, mut incident) = open();
    quarantine_member(&covenant, &mut incident, PROTOCOL_A).expect("quarantined");
    quarantine_member(&covenant, &mut incident, PROTOCOL_B).expect("quarantined");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::Impossible);
    assert_eq!(result.tally.eligible, 1);
    assert_eq!(incident.snapshot.required_approvals, 2);
}

#[test]
fn quarantine_is_idempotent() {
    let (covenant, mut incident) = open();
    quarantine_member(&covenant, &mut incident, PROTOCOL_A).expect("quarantined");
    quarantine_member(&covenant, &mut incident, PROTOCOL_A).expect("quarantined again");
    assert_eq!(incident.quarantined.len(), 1);
}

#[test]
fn quarantining_a_non_member_is_refused() {
    let (covenant, mut incident) = open();
    assert_eq!(
        quarantine_member(
            &covenant,
            &mut incident,
            vinct_types::Address::from_seed(0xFF)
        ),
        Err(EvaluationError::NotAMember)
    );
}

// ---------------------------------------------------------------------- expiry

#[test]
fn expiry_before_the_threshold_expires_the_incident() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    let deadline = incident.snapshot.expires_at_slot;
    let result = evaluate_incident(&covenant, &incident, deadline).expect("evaluates");
    assert_eq!(result.outcome, EvaluationOutcome::Expired);
}

#[test]
fn the_deadline_slot_itself_is_expired() {
    let (covenant, incident) = open();
    let deadline = incident.snapshot.expires_at_slot;
    assert!(!incident.snapshot.is_expired(deadline - 1));
    assert!(incident.snapshot.is_expired(deadline));
    assert_eq!(
        evaluate_incident(&covenant, &incident, deadline - 1)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Collecting
    );
}

#[test]
fn a_met_threshold_survives_the_deadline() {
    // Certification is decided by the attestations that arrived in time. Once the
    // threshold is met the incident is certified, and a slow settlement path must not
    // silently turn it back into an expiry.
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_B, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    let deadline = incident.snapshot.expires_at_slot;
    assert_eq!(
        evaluate_incident(&covenant, &incident, deadline + 100)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Certified
    );
}

#[test]
fn submitting_after_the_deadline_is_refused() {
    let (covenant, mut incident) = open();
    let deadline = incident.snapshot.expires_at_slot;
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(PROTOCOL_A, Decision::Approve, 1),
            deadline
        ),
        Err(EvaluationError::IncidentExpired)
    );
}

#[test]
fn submitting_to_a_terminal_incident_is_refused() {
    let (covenant, mut incident) = open();
    incident.status = IncidentStatus::Settled;
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(PROTOCOL_A, Decision::Approve, 1),
            NOW
        ),
        Err(EvaluationError::IncidentNotCollecting)
    );
}

#[test]
fn submitting_outside_the_epoch_window_is_refused() {
    let mut covenant = covenant_snapshot();
    covenant.expires_at_slot = OPENED;
    let (_, mut incident) = open();
    assert_eq!(
        submit_attestation(
            &covenant,
            &mut incident,
            attest(PROTOCOL_A, Decision::Approve, 1),
            NOW
        ),
        Err(EvaluationError::EpochNotActive)
    );
}

// ------------------------------------------------------------- cross-incident

#[test]
fn an_attestation_for_another_incident_is_refused() {
    let (covenant, mut incident) = open();
    let foreign = AttestationV1::new(COVENANT, 1, 999, PROTOCOL_A, Decision::Approve, 1, NOW);
    assert_eq!(
        submit_attestation(&covenant, &mut incident, foreign, NOW),
        Err(EvaluationError::IncidentMismatch)
    );
}

#[test]
fn an_attestation_for_another_epoch_is_refused() {
    let (covenant, mut incident) = open();
    let foreign = AttestationV1::new(COVENANT, 2, 7, PROTOCOL_A, Decision::Approve, 1, NOW);
    assert_eq!(
        submit_attestation(&covenant, &mut incident, foreign, NOW),
        Err(EvaluationError::IncidentMismatch)
    );
}

#[test]
fn an_attestation_for_another_covenant_is_refused() {
    let (covenant, mut incident) = open();
    let foreign = AttestationV1::new(
        vinct_types::Address::from_seed(0xEE),
        1,
        7,
        PROTOCOL_A,
        Decision::Approve,
        1,
        NOW,
    );
    assert_eq!(
        submit_attestation(&covenant, &mut incident, foreign, NOW),
        Err(EvaluationError::IncidentMismatch)
    );
}

// -------------------------------------------------------------- observer view

#[test]
fn the_public_view_carries_no_counts() {
    let (covenant, mut incident) = open();
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
    let view = public_view(&incident, &result, NOW);

    // The struct is exhaustively destructured on purpose. Adding a count field later
    // fails to compile here rather than quietly leaking live quorum progress.
    let PublicIncidentView {
        incident_id,
        status,
        expires_at_slot,
        is_terminal,
    } = view;
    assert_eq!(incident_id, 7);
    assert_eq!(status, IncidentStatus::Collecting);
    assert_eq!(expires_at_slot, incident.snapshot.expires_at_slot);
    assert!(!is_terminal);
}

#[test]
fn the_public_view_is_identical_for_zero_and_one_approvals() {
    let (covenant, incident_empty) = open();
    let (_, mut incident_one) = open();
    submit_attestation(
        &covenant,
        &mut incident_one,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");

    let empty = public_view(
        &incident_empty,
        &evaluate_incident(&covenant, &incident_empty, NOW).expect("evaluates"),
        NOW,
    );
    let one = public_view(
        &incident_one,
        &evaluate_incident(&covenant, &incident_one, NOW).expect("evaluates"),
        NOW,
    );
    assert_eq!(
        empty, one,
        "an observer can distinguish live quorum progress"
    );
}

#[test]
fn the_public_view_reports_expiry_once_the_deadline_passes() {
    let (covenant, incident) = open();
    let deadline = incident.snapshot.expires_at_slot;
    let result = evaluate_incident(&covenant, &incident, deadline).expect("evaluates");
    let view = public_view(&incident, &result, deadline);
    assert_eq!(view.status, IncidentStatus::Expired);
    assert!(view.is_terminal);
}

// -------------------------------------------------------------- degenerate

#[test]
fn a_zero_threshold_snapshot_is_refused() {
    let (covenant, mut incident) = open();
    incident.snapshot.required_approvals = 0;
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW),
        Err(EvaluationError::ZeroThreshold)
    );
}

#[test]
fn a_single_member_covenant_still_needs_its_one_approval() {
    let mut covenant = covenant_snapshot();
    covenant.member_set = MemberSetV1::new(vec![MemberV1::new(
        PROTOCOL_A,
        MemberRole::Protocol,
        CAPABILITY_A,
        1,
    )])
    .expect("valid");
    covenant.policy.required_approvals = 1;

    let mut snapshot = incident_snapshot(7, OPENED);
    snapshot.member_set_hash = covenant.member_set.hash().expect("hashes");
    snapshot.required_approvals = 1;
    let mut incident = IncidentState::open(snapshot);

    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Collecting
    );
    submit_attestation(
        &covenant,
        &mut incident,
        attest(PROTOCOL_A, Decision::Approve, 1),
        NOW,
    )
    .expect("accepted");
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Certified
    );
}

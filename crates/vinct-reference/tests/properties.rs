//! Property tests over covenants larger than the exhaustively enumerated three.
//!
//! The exhaustive suite proves the hackathon covenant exactly. These properties check
//! that the same rules hold for member sets, thresholds, and submission orders the
//! enumeration cannot cover.

use proptest::prelude::*;

use vinct_reference::evaluate::*;
use vinct_reference::fixtures::*;
use vinct_reference::model::*;
use vinct_types::action::{operation_id, OperationInputsV1};
use vinct_types::attestation::{AttestationV1, Decision};
use vinct_types::covenant::{MemberRole, MemberSetV1, MemberV1};
use vinct_types::hash::sha256;
use vinct_types::settlement::*;
use vinct_types::Address;

const OPENED: u64 = 1_000;
const NOW: u64 = 1_100;

fn decision_strategy() -> impl Strategy<Value = Option<Decision>> {
    prop_oneof![
        Just(None),
        Just(Some(Decision::Approve)),
        Just(Some(Decision::Reject)),
        Just(Some(Decision::Abstain)),
    ]
}

/// Builds a covenant of `member_count` members with the given threshold and ceiling.
fn covenant_of(
    member_count: usize,
    threshold: u8,
    ceiling: u8,
) -> (CovenantSnapshot, IncidentState) {
    let members: Vec<MemberV1> = (0..member_count)
        .map(|index| {
            MemberV1::new(
                Address::from_seed(0x40 + index as u8),
                MemberRole::Protocol,
                Address::from_seed(0x80 + index as u8),
                1,
            )
        })
        .collect();
    let member_set = MemberSetV1::new(members).expect("distinct seeds");

    let mut covenant = covenant_snapshot();
    covenant.member_set = member_set;
    covenant.policy.required_approvals = threshold;
    covenant.policy.maximum_rejections = ceiling;
    covenant.policy.eligible_member_set_hash = covenant.member_set.hash().expect("hashes");

    let mut snapshot = incident_snapshot(7, OPENED);
    snapshot.member_set_hash = covenant.member_set.hash().expect("hashes");
    snapshot.required_approvals = threshold;
    snapshot.maximum_rejections = ceiling;

    (covenant, IncidentState::open(snapshot))
}

fn members_of(count: usize) -> Vec<Address> {
    (0..count)
        .map(|i| Address::from_seed(0x40 + i as u8))
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Certification implies the threshold was met and the ceiling was not breached.
    #[test]
    fn certification_implies_threshold(
        member_count in 2usize..=8,
        threshold_offset in 0u8..8,
        ceiling in 0u8..4,
        decisions in prop::collection::vec(decision_strategy(), 8),
    ) {
        let threshold = 1 + (threshold_offset % member_count as u8);
        let (covenant, mut incident) = covenant_of(member_count, threshold, ceiling);

        for (index, member) in members_of(member_count).iter().enumerate() {
            if let Some(Some(decision)) = decisions.get(index).copied() {
                let attestation = AttestationV1::new(
                    COVENANT, covenant.circle_epoch, 7, *member, decision, 1, NOW,
                );
                submit_attestation(&covenant, &mut incident, attestation, NOW)
                    .expect("well-formed submission");
            }
        }

        let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
        if result.outcome == EvaluationOutcome::Certified {
            prop_assert!(result.tally.approvals >= threshold);
            prop_assert!(result.tally.rejections <= ceiling);
        }
    }

    /// A member never contributes more than one effective decision, however many times
    /// they resubmit and in whatever order the decisions arrive.
    #[test]
    fn resubmission_never_multiplies_a_vote(
        member_count in 2usize..=6,
        resubmissions in prop::collection::vec(decision_strategy(), 1..12),
    ) {
        let (covenant, mut incident) = covenant_of(member_count, 2, 1);
        let member = members_of(member_count)[0];

        let mut nonce = 0u64;
        for decision in resubmissions.iter().flatten() {
            nonce += 1;
            let attestation = AttestationV1::new(
                COVENANT, covenant.circle_epoch, 7, member, *decision, nonce, NOW,
            );
            submit_attestation(&covenant, &mut incident, attestation, NOW)
                .expect("strictly increasing nonce");
        }

        let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
        let counted = result.tally.approvals + result.tally.rejections + result.tally.abstentions;
        prop_assert!(counted <= 1, "one member produced {} effective decisions", counted);
    }

    /// The order attestations arrive in never changes the outcome.
    #[test]
    fn submission_order_does_not_change_the_outcome(
        member_count in 2usize..=6,
        decisions in prop::collection::vec(decision_strategy(), 6),
        rotation in 0usize..6,
    ) {
        let members = members_of(member_count);

        let evaluate_in_order = |order: Vec<usize>| {
            let (covenant, mut incident) = covenant_of(member_count, 2, 1);
            for index in order {
                if let Some(Some(decision)) = decisions.get(index).copied() {
                    let attestation = AttestationV1::new(
                        COVENANT, covenant.circle_epoch, 7, members[index], decision, 1, NOW,
                    );
                    submit_attestation(&covenant, &mut incident, attestation, NOW)
                        .expect("well-formed");
                }
            }
            evaluate_incident(&covenant, &incident, NOW).expect("evaluates")
        };

        let forward: Vec<usize> = (0..member_count).collect();
        let mut rotated = forward.clone();
        rotated.rotate_left(rotation % member_count.max(1));

        prop_assert_eq!(evaluate_in_order(forward), evaluate_in_order(rotated));
    }

    /// Quarantine never lowers the threshold and never turns a non-certified incident
    /// into a certified one.
    #[test]
    fn quarantine_never_helps_certification(
        member_count in 2usize..=7,
        decisions in prop::collection::vec(decision_strategy(), 7),
        quarantine_mask in 0u8..128,
    ) {
        let members = members_of(member_count);
        let (covenant, mut before) = covenant_of(member_count, 2, 1);

        for (index, member) in members.iter().enumerate() {
            if let Some(Some(decision)) = decisions.get(index).copied() {
                let attestation = AttestationV1::new(
                    COVENANT, covenant.circle_epoch, 7, *member, decision, 1, NOW,
                );
                submit_attestation(&covenant, &mut before, attestation, NOW).expect("well-formed");
            }
        }
        let baseline = evaluate_incident(&covenant, &before, NOW).expect("evaluates");

        let mut after = before.clone();
        for (index, member) in members.iter().enumerate() {
            if quarantine_mask & (1 << index) != 0 {
                quarantine_member(&covenant, &mut after, *member).expect("member exists");
            }
        }
        let quarantined = evaluate_incident(&covenant, &after, NOW).expect("evaluates");

        prop_assert_eq!(
            after.snapshot.required_approvals,
            before.snapshot.required_approvals
        );
        if baseline.outcome != EvaluationOutcome::Certified {
            prop_assert_ne!(
                quarantined.outcome,
                EvaluationOutcome::Certified,
                "quarantine created a certification that did not exist"
            );
        }
        prop_assert!(quarantined.tally.approvals <= baseline.tally.approvals);
    }

    /// Distinct operation inputs produce distinct operation IDs.
    #[test]
    fn operation_ids_do_not_collide(
        epoch_a in 0u64..1_000,
        epoch_b in 0u64..1_000,
        incident_a in 0u64..1_000,
        incident_b in 0u64..1_000,
        nonce_a in 0u64..1_000,
        nonce_b in 0u64..1_000,
    ) {
        let base = OperationInputsV1 {
            cluster_genesis_hash: FIXTURE_CLUSTER,
            covenant: COVENANT,
            circle_epoch: epoch_a,
            incident_id: incident_a,
            policy_id: policy_id(),
            member_set_hash: member_set().hash().expect("hashes"),
            action_bundle_template_hash: bundle_template().hash().expect("hashes"),
            certificate_nonce: nonce_a,
        };
        let other = OperationInputsV1 {
            circle_epoch: epoch_b,
            incident_id: incident_b,
            certificate_nonce: nonce_b,
            ..base
        };

        let same_inputs = epoch_a == epoch_b && incident_a == incident_b && nonce_a == nonce_b;
        if same_inputs {
            prop_assert_eq!(operation_id(&base), operation_id(&other));
        } else {
            prop_assert_ne!(operation_id(&base), operation_id(&other));
        }
    }

    /// Settlement never reaches `AllActionsApplied` unless every action was positively
    /// observed as applied and the settlement receipt is present.
    #[test]
    fn settled_requires_every_effect(
        action_count in 1usize..=6,
        receipts in prop::collection::vec(0u8..3, 6),
        effects in prop::collection::vec(0u8..3, 6),
        checkpoint_code in 0u8..3,
        final_code in 0u8..3,
    ) {
        let to_observation = |code: u8| match code {
            0 => ObservationV1::Present,
            1 => ObservationV1::Absent,
            _ => ObservationV1::NotObserved,
        };

        let actions: Vec<ActionObservationV1> = (0..action_count)
            .map(|index| ActionObservationV1 {
                action_index: index as u16,
                receipt: to_observation(receipts[index]),
                target_effect: to_observation(effects[index]),
                delivery_state: ActionDeliveryState::AttemptObserved,
            })
            .collect();

        let observation = SettlementObservationV1 {
            operation_id: sha256(b"operation"),
            certificate_checkpoint: to_observation(checkpoint_code),
            settlement_receipt: to_observation(final_code),
            actions: actions.clone(),
        };

        let classification = classify(&observation);
        if classification == SettlementClassification::AllActionsApplied {
            prop_assert_eq!(to_observation(final_code), ObservationV1::Present);
            for action in &actions {
                prop_assert!(action.is_applied());
            }
        }

        // Recovery is only ever permitted from CommitWithoutActions.
        if permits_recovery(classification) {
            prop_assert_eq!(classification, SettlementClassification::CommitWithoutActions);
        }
    }

    /// The observer view is a function of status and deadline alone, so no tally can leak
    /// through it.
    #[test]
    fn observer_view_leaks_no_tally(
        member_count in 2usize..=7,
        decisions_a in prop::collection::vec(decision_strategy(), 7),
        decisions_b in prop::collection::vec(decision_strategy(), 7),
    ) {
        let members = members_of(member_count);

        let build = |decisions: &Vec<Option<Decision>>| {
            let (covenant, mut incident) = covenant_of(member_count, 2, 1);
            for (index, member) in members.iter().enumerate() {
                if let Some(Some(decision)) = decisions.get(index).copied() {
                    let attestation = AttestationV1::new(
                        COVENANT, covenant.circle_epoch, 7, *member, decision, 1, NOW,
                    );
                    submit_attestation(&covenant, &mut incident, attestation, NOW)
                        .expect("well-formed");
                }
            }
            let result = evaluate_incident(&covenant, &incident, NOW).expect("evaluates");
            public_view(&incident, &result, NOW)
        };

        let view_a = build(&decisions_a);
        let view_b = build(&decisions_b);
        if view_a.status == view_b.status {
            prop_assert_eq!(view_a, view_b, "observer views diverged despite equal status");
        }
    }
}

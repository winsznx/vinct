//! Exhaustive enumeration of the three-member covenant.
//!
//! The hackathon covenant is three members, a threshold of two, and a rejection ceiling
//! of one. That state space is small enough to enumerate completely, so it is enumerated
//! completely rather than sampled: every combination of per-member decision, every
//! quarantine subset, and both sides of the deadline.
//!
//! The run writes `artifacts/test-vectors/exhaustive-three-member.json` as the report the
//! Phase 1 gate requires.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use vinct_reference::evaluate::*;
use vinct_reference::fixtures::*;
use vinct_reference::model::*;
use vinct_types::attestation::{AttestationV1, Decision};
use vinct_types::zeroize::ZeroizationState;
use vinct_types::Address;

const OPENED: u64 = 1_000;
const BEFORE_DEADLINE: u64 = 1_100;

/// What one member did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Choice {
    Silent,
    Approve,
    Reject,
    Abstain,
}

impl Choice {
    const ALL: [Choice; 4] = [
        Choice::Silent,
        Choice::Approve,
        Choice::Reject,
        Choice::Abstain,
    ];

    fn decision(self) -> Option<Decision> {
        match self {
            Choice::Silent => None,
            Choice::Approve => Some(Decision::Approve),
            Choice::Reject => Some(Decision::Reject),
            Choice::Abstain => Some(Decision::Abstain),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Choice::Silent => "silent",
            Choice::Approve => "approve",
            Choice::Reject => "reject",
            Choice::Abstain => "abstain",
        }
    }
}

fn outcome_label(outcome: EvaluationOutcome) -> &'static str {
    match outcome {
        EvaluationOutcome::Collecting => "collecting",
        EvaluationOutcome::Certified => "certified",
        EvaluationOutcome::RejectedByThreshold => "rejected_by_threshold",
        EvaluationOutcome::Expired => "expired",
        EvaluationOutcome::Impossible => "impossible",
    }
}

struct Case {
    choices: [Choice; 3],
    quarantined: [bool; 3],
    now_slot: u64,
    outcome: EvaluationOutcome,
    tally: Tally,
}

fn build(choices: [Choice; 3], quarantined: [bool; 3]) -> (CovenantSnapshot, IncidentState) {
    let covenant = covenant_snapshot();
    let mut incident = incident_state(7, OPENED);
    let members = [PROTOCOL_A, PROTOCOL_B, PROTOCOL_C];

    // Attestations are submitted before quarantine so the quarantine path is exercised
    // against a member who already voted, which is the case that matters.
    for (index, member) in members.iter().enumerate() {
        if let Some(decision) = choices[index].decision() {
            let attestation = AttestationV1::new(
                COVENANT,
                covenant.circle_epoch,
                7,
                *member,
                decision,
                1,
                BEFORE_DEADLINE,
            );
            submit_attestation(&covenant, &mut incident, attestation, BEFORE_DEADLINE)
                .expect("fixture submission is valid");
        }
    }
    for (index, member) in members.iter().enumerate() {
        if quarantined[index] {
            quarantine_member(&covenant, &mut incident, *member).expect("member exists");
        }
    }
    (covenant, incident)
}

fn enumerate() -> Vec<Case> {
    let mut cases = Vec::new();
    for a in Choice::ALL {
        for b in Choice::ALL {
            for c in Choice::ALL {
                for quarantine_mask in 0u8..8 {
                    let quarantined = [
                        quarantine_mask & 0b001 != 0,
                        quarantine_mask & 0b010 != 0,
                        quarantine_mask & 0b100 != 0,
                    ];
                    let (covenant, incident) = build([a, b, c], quarantined);
                    let deadline = incident.snapshot.expires_at_slot;
                    for now_slot in [BEFORE_DEADLINE, deadline] {
                        let result = evaluate_incident(&covenant, &incident, now_slot)
                            .expect("fixture always evaluates");
                        cases.push(Case {
                            choices: [a, b, c],
                            quarantined,
                            now_slot,
                            outcome: result.outcome,
                            tally: result.tally,
                        });
                    }
                }
            }
        }
    }
    cases
}

#[test]
fn the_state_space_is_fully_enumerated() {
    let cases = enumerate();
    // 4 choices per member, 3 members, 8 quarantine subsets, 2 sides of the deadline.
    assert_eq!(cases.len(), 4 * 4 * 4 * 8 * 2);
}

#[test]
fn certification_always_implies_the_threshold_was_met() {
    for case in enumerate() {
        if case.outcome == EvaluationOutcome::Certified {
            assert!(
                case.tally.approvals >= 2,
                "certified with {} approvals: {:?}",
                case.tally.approvals,
                case.choices
            );
            assert!(
                case.tally.rejections <= 1,
                "certified past the rejection ceiling: {:?}",
                case.choices
            );
        }
    }
}

#[test]
fn quarantine_never_lowers_the_threshold_anywhere_in_the_space() {
    for case in enumerate() {
        let (_, incident) = build(case.choices, case.quarantined);
        assert_eq!(
            incident.snapshot.required_approvals, 2,
            "the frozen threshold moved"
        );
    }
}

#[test]
fn a_quarantined_member_never_contributes_an_approval() {
    for case in enumerate() {
        let quarantined_count = case.quarantined.iter().filter(|q| **q).count() as u8;
        assert_eq!(case.tally.quarantined, quarantined_count);
        assert_eq!(
            case.tally.eligible,
            3 - quarantined_count,
            "eligible count did not shrink with quarantine"
        );

        // Approvals and abstentions come only from members who are still eligible. A
        // quarantined key must not be able to authorise anything.
        assert!(
            case.tally.approvals + case.tally.abstentions <= case.tally.eligible,
            "a quarantined member contributed an approval or abstention"
        );

        // Rejections are counted over every member, so they can exceed the eligible
        // count. That asymmetry is deliberate: see the quarantine tests below.
        assert!(case.tally.rejections <= 3);
    }
}

#[test]
fn quarantining_dissenters_can_never_unblock_a_certification() {
    // The property test found this. Discarding a quarantined member's rejection let
    // whoever holds the quarantine authority erase objections until the ceiling stopped
    // blocking, turning a RejectedByThreshold incident into a Certified one. PRD section
    // 21 requires that quarantine cannot certify an incident.
    for a in Choice::ALL {
        for b in Choice::ALL {
            for c in Choice::ALL {
                let (covenant, before) = build([a, b, c], [false; 3]);
                let baseline =
                    evaluate_incident(&covenant, &before, BEFORE_DEADLINE).expect("evaluates");
                if baseline.outcome == EvaluationOutcome::Certified {
                    continue;
                }
                for mask in 1u8..8 {
                    let quarantined = [mask & 0b001 != 0, mask & 0b010 != 0, mask & 0b100 != 0];
                    let (covenant, after) = build([a, b, c], quarantined);
                    let result =
                        evaluate_incident(&covenant, &after, BEFORE_DEADLINE).expect("evaluates");
                    assert_ne!(
                        result.outcome,
                        EvaluationOutcome::Certified,
                        "quarantining {quarantined:?} certified {:?}, which was {:?} before",
                        [a, b, c],
                        baseline.outcome
                    );
                }
            }
        }
    }
}

#[test]
fn quarantine_never_reduces_the_rejection_count() {
    for a in Choice::ALL {
        for b in Choice::ALL {
            for c in Choice::ALL {
                let (covenant, before) = build([a, b, c], [false; 3]);
                let baseline =
                    evaluate_incident(&covenant, &before, BEFORE_DEADLINE).expect("evaluates");
                for mask in 0u8..8 {
                    let quarantined = [mask & 0b001 != 0, mask & 0b010 != 0, mask & 0b100 != 0];
                    let (covenant, after) = build([a, b, c], quarantined);
                    let result =
                        evaluate_incident(&covenant, &after, BEFORE_DEADLINE).expect("evaluates");
                    assert!(
                        result.tally.rejections >= baseline.tally.rejections,
                        "quarantine erased an objection"
                    );
                    assert!(
                        result.tally.approvals <= baseline.tally.approvals,
                        "quarantine created an approval"
                    );
                }
            }
        }
    }
}

#[test]
fn quarantining_every_member_can_never_certify() {
    for a in Choice::ALL {
        for b in Choice::ALL {
            for c in Choice::ALL {
                let (covenant, incident) = build([a, b, c], [true, true, true]);
                let result =
                    evaluate_incident(&covenant, &incident, BEFORE_DEADLINE).expect("evaluates");
                assert_ne!(
                    result.outcome,
                    EvaluationOutcome::Certified,
                    "a fully quarantined covenant certified"
                );
                assert_eq!(result.tally.eligible, 0);
            }
        }
    }
}

#[test]
fn evaluation_is_deterministic_across_the_whole_space() {
    for case in enumerate() {
        let (covenant, incident) = build(case.choices, case.quarantined);
        let first = evaluate_incident(&covenant, &incident, case.now_slot).expect("evaluates");
        let second = evaluate_incident(&covenant, &incident, case.now_slot).expect("evaluates");
        assert_eq!(first, second);
        assert_eq!(first.outcome, case.outcome);
    }
}

#[test]
fn adding_an_approval_never_removes_certification() {
    // Monotonicity in the direction that matters. Turning a silent or abstaining member
    // into an approver must never undo a certification that had already been reached.
    for a in Choice::ALL {
        for b in Choice::ALL {
            for c in Choice::ALL {
                let base = [a, b, c];
                let (covenant, incident) = build(base, [false; 3]);
                let before = evaluate_incident(&covenant, &incident, BEFORE_DEADLINE)
                    .expect("evaluates")
                    .outcome;
                if before != EvaluationOutcome::Certified {
                    continue;
                }
                for position in 0..3 {
                    if matches!(base[position], Choice::Reject) {
                        continue;
                    }
                    let mut upgraded = base;
                    upgraded[position] = Choice::Approve;
                    let (covenant, incident) = build(upgraded, [false; 3]);
                    let after = evaluate_incident(&covenant, &incident, BEFORE_DEADLINE)
                        .expect("evaluates")
                        .outcome;
                    assert_eq!(
                        after,
                        EvaluationOutcome::Certified,
                        "adding an approval to {base:?} at {position} lost certification"
                    );
                }
            }
        }
    }
}

#[test]
fn the_public_view_never_distinguishes_two_states_with_the_same_status() {
    // The privacy claim, tested across the whole space. Any two live incidents that share
    // a lifecycle status and deadline must be indistinguishable to an observer, whatever
    // their internal tallies are.
    let mut by_status: BTreeMap<(String, u64), Vec<PublicIncidentView>> = BTreeMap::new();
    for case in enumerate() {
        let (covenant, incident) = build(case.choices, case.quarantined);
        let result = evaluate_incident(&covenant, &incident, case.now_slot).expect("evaluates");
        let view = public_view(&incident, &result, case.now_slot);
        by_status
            .entry((format!("{:?}", view.status), view.expires_at_slot))
            .or_default()
            .push(view);
    }
    for ((status, deadline), views) in by_status {
        let first = views[0];
        for view in &views {
            assert_eq!(
                *view, first,
                "two incidents sharing status {status} and deadline {deadline} produced different observer views"
            );
        }
    }
}

#[test]
fn certification_requires_a_scrubbed_account_everywhere_it_is_possible() {
    let resolved = resolved_addresses();
    for case in enumerate() {
        if case.outcome != EvaluationOutcome::Certified {
            continue;
        }
        let (covenant, incident) = build(case.choices, case.quarantined);

        let dirty = vinct_reference::certify(
            &covenant,
            &incident,
            ZeroizationState::DIRTY,
            CERTIFICATE_NONCE,
            &CAPABILITY_NONCES,
            &resolved,
            case.now_slot,
        );
        assert!(
            matches!(
                dirty,
                Err(vinct_reference::CertificationError::NotZeroized(_))
            ),
            "an unscrubbed incident produced a certificate"
        );

        let clean = vinct_reference::certify(
            &covenant,
            &incident,
            ZeroizationState::CLEAN,
            CERTIFICATE_NONCE,
            &CAPABILITY_NONCES,
            &resolved,
            case.now_slot,
        )
        .expect("a certified, scrubbed incident issues a certificate");
        assert_eq!(clean.certificate.approval_count, case.tally.approvals);
        assert_eq!(clean.certificate.rejection_count, case.tally.rejections);
    }
}

#[test]
fn writes_the_exhaustive_report() {
    let cases = enumerate();

    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut rows = Vec::new();
    for case in &cases {
        *counts.entry(outcome_label(case.outcome)).or_default() += 1;
        rows.push(format!(
            r#"    {{"choices":["{}","{}","{}"],"quarantined":[{},{},{}],"at_deadline":{},"outcome":"{}","eligible":{},"approvals":{},"rejections":{},"abstentions":{},"outstanding":{}}}"#,
            case.choices[0].label(),
            case.choices[1].label(),
            case.choices[2].label(),
            case.quarantined[0],
            case.quarantined[1],
            case.quarantined[2],
            case.now_slot != BEFORE_DEADLINE,
            outcome_label(case.outcome),
            case.tally.eligible,
            case.tally.approvals,
            case.tally.rejections,
            case.tally.abstentions,
            case.tally.outstanding,
        ));
    }

    let summary = counts
        .iter()
        .map(|(label, count)| format!(r#"    "{label}": {count}"#))
        .collect::<Vec<_>>()
        .join(",\n");

    let report = format!(
        "{{\n  \"covenant\": \"three members, threshold 2, rejection ceiling 1\",\n  \
         \"dimensions\": {{\"member_choices\": 4, \"members\": 3, \"quarantine_subsets\": 8, \"deadline_sides\": 2}},\n  \
         \"total_states\": {},\n  \"outcome_counts\": {{\n{}\n  }},\n  \"states\": [\n{}\n  ]\n}}\n",
        cases.len(),
        summary,
        rows.join(",\n")
    );

    let path = report_path();
    fs::create_dir_all(path.parent().expect("has a parent")).expect("creates artifact dir");
    fs::write(&path, report).expect("writes the report");
    assert!(path.exists());
}

fn report_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../artifacts/test-vectors")
        .join("exhaustive-three-member.json")
}

/// Unused-import guard: keeps `Address` referenced so the fixture module's type is
/// visible in this file's error messages.
#[allow(dead_code)]
fn _address_type_is_in_scope(a: Address) -> Address {
    a
}

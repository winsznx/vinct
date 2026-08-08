//! The program's certification against the reference model, exhaustively.
//!
//! `crates/vinct-reference` is the executable specification. It is a pure model with no SVM,
//! no accounts, and no permissions, and every economic and state-transition question is
//! answered there first. This file checks that the deployed program answers the same.
//!
//! The three-member covenant is small enough to enumerate completely, so it is enumerated
//! completely rather than sampled: four choices per member, every quarantine subset, and both
//! sides of the deadline. 512 cases, each run through the real SBF program on a real SVM and
//! compared against the model's verdict and tally.
//!
//! What makes this worth the runtime: the two implementations were written from the PRD
//! independently and have no code in common. The program counts by scanning a set of accounts
//! it reconstructs from a commitment; the model counts by walking a vector. Agreement across
//! the whole space is evidence that both read the same specification, and a divergence names
//! the exact case.
//!
//!   anchor build --ignore-keys && cargo test -p vinct-program-tests --test reference_parity

// litesvm returns `Result<TransactionMetadata, FailedTransactionMetadata>`, whose error
// variant is large by design because it carries the full transaction metadata and logs.
#![allow(clippy::result_large_err)]

mod common;

use common::*;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use vinct_program_tests::{instruction_data, instruction_data_empty};
use vinct_reference::evaluate::{evaluate_incident, EvaluationOutcome};
use vinct_reference::model::{CovenantSnapshot, IncidentState};
use vinct_types::attestation::{AttestationV1, Decision as RefDecision};
use vinct_types::covenant::{MemberRole, MemberSetV1, MemberV1};
use vinct_types::Address as RefAddress;

const INCIDENT_SEED: &[u8] = b"incident";
const CLAIM_SEED: &[u8] = b"incident-claim";
const ATTESTATION_SEED: &[u8] = b"incident-attestation";

const REQUIRED_APPROVALS: u8 = 2;
const MAXIMUM_REJECTIONS: u8 = 1;
const RESPONSE_WINDOW: u64 = 400;

const STATUS_CERTIFIED: u8 = 2;
const STATUS_EXPIRED: u8 = 3;
const STATUS_REJECTED: u8 = 4;

/// What one member did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

    /// The program's Borsh enum index, or `None` when the member never submits.
    fn program_decision(self) -> Option<u8> {
        match self {
            Choice::Silent => None,
            Choice::Approve => Some(1),
            Choice::Reject => Some(2),
            Choice::Abstain => Some(3),
        }
    }

    fn reference_decision(self) -> Option<RefDecision> {
        match self {
            Choice::Silent => None,
            Choice::Approve => Some(RefDecision::Approve),
            Choice::Reject => Some(RefDecision::Reject),
            Choice::Abstain => Some(RefDecision::Abstain),
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

#[derive(borsh::BorshSerialize)]
struct InitializeIncidentArgs {
    incident_id: u64,
    covenant: [u8; 32],
}

#[derive(borsh::BorshSerialize)]
struct MemberArg {
    member: [u8; 32],
}

#[derive(borsh::BorshSerialize)]
struct ClaimDigestArg {
    claim_digest: [u8; 32],
}

#[derive(borsh::BorshSerialize)]
struct AttestationArgs {
    decision: u8,
    submission_nonce: u64,
}

/// What the program decided, read back off the public core.
#[derive(Debug, PartialEq, Eq)]
struct ProgramVerdict {
    status: Option<u8>,
    approvals: u8,
    rejections: u8,
}

/// One incident inside a shared SVM.
struct Case {
    core: Address,
    members: Vec<Keypair>,
}

impl Case {
    fn attestation(&self, member: &Address) -> Address {
        Address::find_program_address(
            &[ATTESTATION_SEED, self.core.as_ref(), member.as_ref()],
            &core_program(),
        )
        .0
    }

    fn ballots(&self) -> Vec<Address> {
        self.members
            .iter()
            .map(|member| self.attestation(&member.pubkey()))
            .collect()
    }
}

/// Builds one incident's accounts in the shared world, under an already-formed covenant.
fn create(world: &mut World, covenant: Address, incident_id: u64, members: &[Keypair]) -> Case {
    let opener = members[0].insecure_clone();
    let system = Address::default();
    let (core, _) = Address::find_program_address(
        &[INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
        &core_program(),
    );
    let (claim, _) = Address::find_program_address(&[CLAIM_SEED, core.as_ref()], &core_program());

    world
        .send(
            Instruction {
                program_id: core_program(),
                accounts: vec![
                    AccountMeta::new(core, false),
                    AccountMeta::new_readonly(covenant, false),
                    AccountMeta::new_readonly(
                        covenant_membership(&covenant, &opener.pubkey()),
                        false,
                    ),
                    AccountMeta::new(opener.pubkey(), true),
                    AccountMeta::new_readonly(system, false),
                ],
                data: instruction_data(
                    "initialize_incident",
                    &InitializeIncidentArgs {
                        incident_id,
                        covenant: covenant.to_bytes(),
                    },
                ),
            },
            &[&opener],
        )
        .expect("core initializes");

    world
        .send(
            Instruction {
                program_id: core_program(),
                accounts: vec![
                    AccountMeta::new_readonly(core, false),
                    AccountMeta::new(claim, false),
                    AccountMeta::new(opener.pubkey(), true),
                    AccountMeta::new_readonly(system, false),
                ],
                data: instruction_data_empty("initialize_claim"),
            },
            &[&opener],
        )
        .expect("claim initializes");

    let case = Case {
        core,
        members: members.iter().map(|m| m.insecure_clone()).collect(),
    };
    for member in members {
        world
            .send(
                Instruction {
                    program_id: core_program(),
                    accounts: vec![
                        AccountMeta::new_readonly(core, false),
                        AccountMeta::new_readonly(
                            covenant_membership(&covenant, &member.pubkey()),
                            false,
                        ),
                        AccountMeta::new(case.attestation(&member.pubkey()), false),
                        AccountMeta::new(opener.pubkey(), true),
                        AccountMeta::new_readonly(system, false),
                    ],
                    data: instruction_data(
                        "initialize_attestation",
                        &MemberArg {
                            member: member.pubkey().to_bytes(),
                        },
                    ),
                },
                &[&opener],
            )
            .expect("ballot initializes");
    }
    case
}

fn open(world: &mut World, case: &Case) {
    let opener = case.members[0].insecure_clone();
    let mut accounts = vec![
        AccountMeta::new(case.core, false),
        AccountMeta::new_readonly(opener.pubkey(), true),
    ];
    for ballot in case.ballots() {
        accounts.push(AccountMeta::new_readonly(ballot, false));
    }
    world
        .send(
            Instruction {
                program_id: core_program(),
                accounts,
                data: instruction_data(
                    "open_incident",
                    &ClaimDigestArg {
                        claim_digest: [0u8; 32],
                    },
                ),
            },
            &[&opener],
        )
        .expect("incident opens");
}

fn attest(world: &mut World, case: &Case, index: usize, decision: u8) {
    let member = case.members[index].insecure_clone();
    let instruction = Instruction {
        program_id: core_program(),
        accounts: vec![
            AccountMeta::new_readonly(case.core, false),
            AccountMeta::new(case.attestation(&member.pubkey()), false),
            AccountMeta::new_readonly(member.pubkey(), true),
        ],
        data: instruction_data(
            "submit_sealed_attestation",
            &AttestationArgs {
                decision,
                submission_nonce: 1,
            },
        ),
    };
    world.send(instruction, &[&member]).expect("member attests");
}

fn quarantine(world: &mut World, case: &Case, index: usize) {
    let opener = case.members[0].insecure_clone();
    let member = case.members[index].pubkey();
    let instruction = Instruction {
        program_id: core_program(),
        accounts: vec![
            AccountMeta::new_readonly(case.core, false),
            AccountMeta::new(case.attestation(&member), false),
            AccountMeta::new_readonly(opener.pubkey(), true),
        ],
        data: instruction_data_empty("quarantine_member"),
    };
    world
        .send(instruction, &[&opener])
        .expect("member quarantined");
}

fn certify(
    world: &mut World,
    case: &Case,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let payer = world.payer.insecure_clone();
    let mut accounts = vec![AccountMeta::new(case.core, false)];
    for ballot in case.ballots() {
        accounts.push(AccountMeta::new_readonly(ballot, false));
    }
    world.send(
        Instruction {
            program_id: core_program(),
            accounts,
            data: instruction_data_empty("certify_incident"),
        },
        &[&payer],
    )
}

fn verdict(world: &World, case: &Case) -> ProgramVerdict {
    let data = world.svm.get_account(&case.core).expect("core exists").data;
    let body = &data[8..];
    let status_offset = 2 + 32 + 8 + 8 + 32;
    // version(2) covenant(32) epoch(8) incident_id(8) opener(32) status(1) policy(32)
    // member_set(32) cluster(32) required(1) max_rejections(1) opened(8) expires(8)
    // window(8) template(32) claim_digest(32) operation_id(32) certified_at(8)
    // certificate_lifetime(8) member_count(1) approvals(1) rejections(1)
    let counts =
        2 + 32 + 8 + 8 + 32 + 1 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 32 + 32 + 32 + 8 + 8 + 1;
    ProgramVerdict {
        status: Some(body[status_offset]),
        approvals: body[counts],
        rejections: body[counts + 1],
    }
}

/// Builds the same case in the reference model.
fn reference(
    members: &[Keypair],
    choices: [Choice; 3],
    quarantined: [bool; 3],
    now_slot: u64,
    opened_at: u64,
) -> (CovenantSnapshot, IncidentState, u64) {
    let addresses: Vec<RefAddress> = members
        .iter()
        .map(|m| RefAddress::from(m.pubkey().to_bytes()))
        .collect();

    let mut covenant = vinct_reference::fixtures::covenant_snapshot();
    covenant.member_set = MemberSetV1::new(
        addresses
            .iter()
            .map(|address| MemberV1::new(*address, MemberRole::Protocol, RefAddress::ZERO, 0))
            .collect(),
    )
    .expect("member set");
    covenant.policy.required_approvals = REQUIRED_APPROVALS;
    covenant.policy.maximum_rejections = MAXIMUM_REJECTIONS;

    let mut snapshot = vinct_reference::fixtures::incident_snapshot(1, opened_at);
    snapshot.required_approvals = REQUIRED_APPROVALS;
    snapshot.maximum_rejections = MAXIMUM_REJECTIONS;
    snapshot.member_set_hash = covenant.member_set.hash().expect("member set hashes");
    snapshot.opened_at_slot = opened_at;
    snapshot.expires_at_slot = opened_at + RESPONSE_WINDOW;

    let mut incident = IncidentState::open(snapshot);
    for (index, choice) in choices.iter().enumerate() {
        if let Some(decision) = choice.reference_decision() {
            incident.attestations.push(AttestationV1::new(
                covenant.covenant,
                covenant.circle_epoch,
                incident.snapshot.incident_id,
                addresses[index],
                decision,
                1,
                opened_at + 1,
            ));
        }
    }
    for (index, is_quarantined) in quarantined.iter().enumerate() {
        if *is_quarantined {
            vinct_reference::evaluate::quarantine_member(
                &covenant,
                &mut incident,
                addresses[index],
            )
            .expect("quarantine applies");
        }
    }
    (covenant, incident, now_slot)
}

/// Every combination of three members' choices, quarantine subsets, and both sides of the
/// deadline, run through the program and the model.
#[test]
fn the_program_certifies_exactly_what_the_reference_model_says() {
    let mut world = World::new();
    // 512 incidents, each with five rent-exempt accounts. The fixture's default balances are
    // sized for a handful of incidents, not for the whole state space.
    let steward = world.steward.pubkey();
    world
        .svm
        .airdrop(&steward, 2_000_000_000_000)
        .expect("steward funded for the enumeration");
    let mut members: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    members.sort_by_key(|m| m.pubkey().to_bytes());
    for member in &members {
        world
            .svm
            .airdrop(&member.pubkey(), 2_000_000_000_000)
            .expect("member funded");
    }

    // One covenant for the whole enumeration. Its terms are what every incident inherits,
    // which is the point of the composition: the opener supplies none of them.
    let covenant = world.form_covenant(
        &members,
        REQUIRED_APPROVALS,
        MAXIMUM_REJECTIONS,
        RESPONSE_WINDOW,
    );

    let mut incident_id = 1u64;
    let mut compared = 0usize;
    let mut divergences: Vec<String> = Vec::new();

    for choices in every_choice_triple() {
        for quarantined in every_quarantine_subset() {
            for after_deadline in [false, true] {
                let case = create(&mut world, covenant, incident_id, &members);
                let opened_at = world.current_slot();
                open(&mut world, &case);

                for (index, choice) in choices.iter().enumerate() {
                    if let Some(decision) = choice.program_decision() {
                        attest(&mut world, &case, index, decision);
                    }
                }
                for (index, is_quarantined) in quarantined.iter().enumerate() {
                    if *is_quarantined {
                        quarantine(&mut world, &case, index);
                    }
                }

                if after_deadline {
                    let target = world.current_slot().max(opened_at + RESPONSE_WINDOW + 1);
                    world.svm.warp_to_slot(target);
                }
                let now_slot = world.current_slot();

                let result = certify(&mut world, &case);
                let observed = match &result {
                    Ok(_) => verdict(&world, &case),
                    Err(_) => ProgramVerdict {
                        status: None,
                        approvals: 0,
                        rejections: 0,
                    },
                };

                let (covenant, incident, slot) =
                    reference(&members, choices, quarantined, now_slot, opened_at);
                let expected =
                    evaluate_incident(&covenant, &incident, slot).expect("model evaluates");

                let expected_verdict = match expected.outcome {
                    EvaluationOutcome::Certified => ProgramVerdict {
                        status: Some(STATUS_CERTIFIED),
                        approvals: expected.tally.approvals,
                        rejections: expected.tally.rejections,
                    },
                    EvaluationOutcome::RejectedByThreshold if after_deadline => ProgramVerdict {
                        status: Some(STATUS_REJECTED),
                        approvals: expected.tally.approvals,
                        rejections: expected.tally.rejections,
                    },
                    EvaluationOutcome::Expired => ProgramVerdict {
                        status: Some(STATUS_EXPIRED),
                        approvals: expected.tally.approvals,
                        rejections: expected.tally.rejections,
                    },
                    // Before the deadline the program declines to settle anything that is not
                    // certified, including an incident the model already calls rejected or
                    // impossible. That is deliberate: settling early would announce the exact
                    // moment a blocking rejection landed. The model is a view of the state,
                    // the program is a transition on it, and they agree on the state.
                    _ => ProgramVerdict {
                        status: None,
                        approvals: 0,
                        rejections: 0,
                    },
                };

                if observed != expected_verdict {
                    divergences.push(format!(
                        "choices=[{}] quarantined={:?} after_deadline={after_deadline}: program {observed:?}, model {:?} ({:?})",
                        choices.map(|c| c.label()).join(","),
                        quarantined,
                        expected_verdict,
                        expected.outcome,
                    ));
                }
                compared += 1;
                incident_id += 1;
            }
        }
    }

    assert!(
        divergences.is_empty(),
        "{} of {compared} cases diverged from the reference model:\n{}",
        divergences.len(),
        divergences.join("\n")
    );
    assert_eq!(
        compared,
        4 * 4 * 4 * 8 * 2,
        "the enumeration was not complete"
    );
}

fn every_choice_triple() -> Vec<[Choice; 3]> {
    let mut all = Vec::new();
    for a in Choice::ALL {
        for b in Choice::ALL {
            for c in Choice::ALL {
                all.push([a, b, c]);
            }
        }
    }
    all
}

fn every_quarantine_subset() -> Vec<[bool; 3]> {
    let mut all = Vec::new();
    for mask in 0..8u8 {
        all.push([mask & 1 != 0, mask & 2 != 0, mask & 4 != 0]);
    }
    all
}

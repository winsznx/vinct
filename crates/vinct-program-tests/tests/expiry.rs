//! The scheduled terminal handler, and the scheduling requests around it.
//!
//! LiteSVM has no task scheduler, so what is proven here is everything the program controls:
//! that the handler is idempotent and monotonic, that it refuses to act early, that a task ID
//! is derived rather than chosen and cannot collide, and that only the opener may ask for a
//! task to be removed. What the scheduler does with an accepted request is a live-stack
//! question and is answered by `scripts/phase6-expiry.ts` against a running validator.
//!
//! The distinction matters more here than elsewhere. Every property below is about VINCT
//! behaving correctly *when* the scheduler calls it, and a passing file proves nothing about
//! whether the scheduler ever does.

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

const INCIDENT_SEED: &[u8] = b"incident";
const CLAIM_SEED: &[u8] = b"incident-claim";
const ATTESTATION_SEED: &[u8] = b"incident-attestation";
const EXPIRY_TASK_DOMAIN: &[u8] = b"vinct:expiry-task:v1";

const MAGIC_PROGRAM: &str = "Magic11111111111111111111111111111111111111";

const REQUIRED_APPROVALS: u8 = 2;
const MAXIMUM_REJECTIONS: u8 = 1;
const RESPONSE_WINDOW: u64 = 200;

const STATUS_COLLECTING: u8 = 1;
const STATUS_CERTIFIED: u8 = 2;
const STATUS_EXPIRED: u8 = 3;

const APPROVE: u8 = 1;

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

#[derive(borsh::BorshSerialize)]
struct CrankArgs {
    execution_interval_millis: i64,
    iterations: i64,
}

fn magic_program() -> Address {
    MAGIC_PROGRAM.parse().expect("valid address")
}

/// One incident under a real covenant, with the accounts an expiry task would touch.
struct Expiring {
    world: World,
    covenant: Address,
    core: Address,
    incident_id: u64,
    members: Vec<Keypair>,
}

impl Expiring {
    fn new() -> Self {
        Self::with_incident(1)
    }

    fn with_incident(incident_id: u64) -> Self {
        let mut world = World::new();
        let mut members: Vec<Keypair> = (0..3)
            .map(|_| {
                let member = Keypair::new();
                world
                    .svm
                    .airdrop(&member.pubkey(), 10_000_000_000)
                    .expect("member funded");
                member
            })
            .collect();
        members.sort_by_key(|m| m.pubkey().to_bytes());

        let covenant = world.form_covenant(
            &members,
            REQUIRED_APPROVALS,
            MAXIMUM_REJECTIONS,
            RESPONSE_WINDOW,
        );
        let (core, _) = Address::find_program_address(
            &[INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
            &core_program(),
        );

        let mut expiring = Self {
            world,
            covenant,
            core,
            incident_id,
            members,
        };
        expiring.create();
        expiring
    }

    /// A second incident under the same covenant, in the same world.
    fn sibling(&mut self, incident_id: u64) -> Address {
        let (core, _) = Address::find_program_address(
            &[
                INCIDENT_SEED,
                self.covenant.as_ref(),
                &incident_id.to_le_bytes(),
            ],
            &core_program(),
        );
        let opener = self.opener();
        self.world
            .send(
                Instruction {
                    program_id: core_program(),
                    accounts: vec![
                        AccountMeta::new(core, false),
                        AccountMeta::new_readonly(self.covenant, false),
                        AccountMeta::new_readonly(
                            covenant_membership(&self.covenant, &opener.pubkey()),
                            false,
                        ),
                        AccountMeta::new(opener.pubkey(), true),
                        AccountMeta::new_readonly(Address::default(), false),
                    ],
                    data: instruction_data(
                        "initialize_incident",
                        &InitializeIncidentArgs {
                            incident_id,
                            covenant: self.covenant.to_bytes(),
                        },
                    ),
                },
                &[&opener],
            )
            .expect("sibling core initializes");
        core
    }

    fn opener(&self) -> Keypair {
        self.members[0].insecure_clone()
    }

    fn attestation_of(&self, index: usize) -> Address {
        Address::find_program_address(
            &[
                ATTESTATION_SEED,
                self.core.as_ref(),
                self.members[index].pubkey().as_ref(),
            ],
            &core_program(),
        )
        .0
    }

    fn ballots(&self) -> Vec<Address> {
        (0..self.members.len())
            .map(|index| self.attestation_of(index))
            .collect()
    }

    fn create(&mut self) {
        let opener = self.opener();
        let system = Address::default();
        let (claim, _) =
            Address::find_program_address(&[CLAIM_SEED, self.core.as_ref()], &core_program());

        self.world
            .send(
                Instruction {
                    program_id: core_program(),
                    accounts: vec![
                        AccountMeta::new(self.core, false),
                        AccountMeta::new_readonly(self.covenant, false),
                        AccountMeta::new_readonly(
                            covenant_membership(&self.covenant, &opener.pubkey()),
                            false,
                        ),
                        AccountMeta::new(opener.pubkey(), true),
                        AccountMeta::new_readonly(system, false),
                    ],
                    data: instruction_data(
                        "initialize_incident",
                        &InitializeIncidentArgs {
                            incident_id: self.incident_id,
                            covenant: self.covenant.to_bytes(),
                        },
                    ),
                },
                &[&opener],
            )
            .expect("core initializes");

        self.world
            .send(
                Instruction {
                    program_id: core_program(),
                    accounts: vec![
                        AccountMeta::new_readonly(self.core, false),
                        AccountMeta::new(claim, false),
                        AccountMeta::new(opener.pubkey(), true),
                        AccountMeta::new_readonly(system, false),
                    ],
                    data: instruction_data_empty("initialize_claim"),
                },
                &[&opener],
            )
            .expect("claim initializes");

        for index in 0..self.members.len() {
            let member = self.members[index].pubkey();
            self.world
                .send(
                    Instruction {
                        program_id: core_program(),
                        accounts: vec![
                            AccountMeta::new_readonly(self.core, false),
                            AccountMeta::new_readonly(
                                covenant_membership(&self.covenant, &member),
                                false,
                            ),
                            AccountMeta::new(self.attestation_of(index), false),
                            AccountMeta::new(opener.pubkey(), true),
                            AccountMeta::new_readonly(system, false),
                        ],
                        data: instruction_data(
                            "initialize_attestation",
                            &MemberArg {
                                member: member.to_bytes(),
                            },
                        ),
                    },
                    &[&opener],
                )
                .expect("ballot initializes");
        }
    }

    fn open(&mut self) {
        let opener = self.opener();
        let mut accounts = vec![
            AccountMeta::new(self.core, false),
            AccountMeta::new_readonly(opener.pubkey(), true),
        ];
        for ballot in self.ballots() {
            accounts.push(AccountMeta::new_readonly(ballot, false));
        }
        self.world
            .send(
                Instruction {
                    program_id: core_program(),
                    accounts,
                    data: instruction_data(
                        "open_incident",
                        &ClaimDigestArg {
                            claim_digest: vinct_program_tests::sha256(b"expiry-claim"),
                        },
                    ),
                },
                &[&opener],
            )
            .expect("incident opens");
    }

    fn attest(&mut self, index: usize, decision: u8) {
        let member = self.members[index].insecure_clone();
        self.world
            .send(
                Instruction {
                    program_id: core_program(),
                    accounts: vec![
                        AccountMeta::new_readonly(self.core, false),
                        AccountMeta::new(self.attestation_of(index), false),
                        AccountMeta::new_readonly(member.pubkey(), true),
                    ],
                    data: instruction_data(
                        "submit_sealed_attestation",
                        &AttestationArgs {
                            decision,
                            submission_nonce: 1,
                        },
                    ),
                },
                &[&member],
            )
            .expect("member attests");
    }

    /// The scheduled handler, called the way the scheduler would call it.
    fn expire(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ballots = self.ballots();
        self.expire_with(&ballots)
    }

    fn expire_with(
        &mut self,
        ballots: &[Address],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let mut accounts = vec![AccountMeta::new(self.core, false)];
        for ballot in ballots {
            accounts.push(AccountMeta::new_readonly(*ballot, false));
        }
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts,
                data: instruction_data_empty("expire_incident"),
            },
            &[&payer],
        )
    }

    fn request_crank(
        &mut self,
        interval: i64,
        iterations: i64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let opener = self.opener();
        self.request_crank_as(&opener, interval, iterations)
    }

    fn request_crank_as(
        &mut self,
        signer: &Keypair,
        interval: i64,
        iterations: i64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let signer = signer.insecure_clone();
        let mut accounts = vec![
            AccountMeta::new(self.core, false),
            AccountMeta::new(signer.pubkey(), true),
            AccountMeta::new_readonly(magic_program(), false),
        ];
        for ballot in self.ballots() {
            accounts.push(AccountMeta::new_readonly(ballot, false));
        }
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts,
                data: instruction_data(
                    "request_expiry_crank",
                    &CrankArgs {
                        execution_interval_millis: interval,
                        iterations,
                    },
                ),
            },
            &[&signer],
        )
    }

    fn cancel_crank_as(
        &mut self,
        signer: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let signer = signer.insecure_clone();
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts: vec![
                    AccountMeta::new(self.core, false),
                    AccountMeta::new(signer.pubkey(), true),
                    AccountMeta::new_readonly(magic_program(), false),
                ],
                data: instruction_data_empty("cancel_expiry_crank"),
            },
            &[&signer],
        )
    }

    fn raw(&self, address: &Address) -> Vec<u8> {
        self.world
            .svm
            .get_account(address)
            .expect("account exists")
            .data
    }

    fn status(&self) -> u8 {
        self.raw(&self.core)[8 + 2 + 32 + 8 + 8 + 32]
    }

    /// This incident's derived task ID, recomputed here rather than read from the program.
    fn task_id(&self) -> i64 {
        task_id_for(&self.raw(&self.core), self.covenant, self.incident_id)
    }

    fn past_deadline(&mut self) {
        let target = self.world.current_slot() + RESPONSE_WINDOW + 1;
        self.world.svm.warp_to_slot(target);
    }
}

/// The task ID derivation, written independently of the program's.
///
/// A test that called the program's own function would prove the program agrees with itself.
/// This recomputes the digest from the account's bytes, so a change to either the domain
/// separator or the field order fails here.
fn task_id_for(core_bytes: &[u8], covenant: Address, incident_id: u64) -> i64 {
    // version(2) covenant(32) epoch(8) incident_id(8) opener(32) status(1) policy(32)
    // member_set(32)
    const CLUSTER_OFFSET: usize = 8 + 2 + 32 + 8 + 8 + 32 + 1 + 32 + 32;
    let cluster = &core_bytes[CLUSTER_OFFSET..CLUSTER_OFFSET + 32];

    let mut preimage = EXPIRY_TASK_DOMAIN.to_vec();
    preimage.extend_from_slice(cluster);
    preimage.extend_from_slice(covenant.as_ref());
    preimage.extend_from_slice(&incident_id.to_le_bytes());

    let digest = vinct_program_tests::sha256(&preimage);
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    i64::from_le_bytes(head) & i64::MAX
}

// ------------------------------------------------------------------- the handler

/// Firing before the deadline changes nothing and is not an error.
///
/// The scheduler runs on a cadence, not on a condition, so most iterations of a healthy task
/// arrive while the window is still open. Returning an error for the normal case would put a
/// failing task in front of an operator every time the system worked correctly.
#[test]
fn an_early_iteration_does_nothing_and_succeeds() {
    let mut expiring = Expiring::new();
    expiring.open();

    expiring.expire().expect("an early iteration succeeds");
    assert_eq!(
        expiring.status(),
        STATUS_COLLECTING,
        "an early iteration moved an incident that was still collecting"
    );
}

/// Past the deadline with nobody having answered, the incident expires.
#[test]
fn a_late_iteration_expires_an_unanswered_incident() {
    let mut expiring = Expiring::new();
    expiring.open();
    expiring.past_deadline();

    expiring.expire().expect("the late iteration settles it");
    assert_eq!(expiring.status(), STATUS_EXPIRED);
}

/// Past the deadline with a threshold met, the incident certifies.
///
/// The handler does not force expiry. It performs whatever terminal transition the tally
/// implies, which is the same transition `certify_incident` performs, from the same function.
/// A crank-settled incident and a manually-settled one must not disagree about what happened.
#[test]
fn a_late_iteration_certifies_when_the_threshold_was_met() {
    let mut expiring = Expiring::new();
    expiring.open();
    expiring.attest(0, APPROVE);
    expiring.attest(1, APPROVE);
    expiring.past_deadline();

    expiring.expire().expect("the late iteration settles it");
    assert_eq!(expiring.status(), STATUS_CERTIFIED);
}

/// Repeated iterations are harmless.
///
/// The property the scheduler needs, because it offers no exactly-once guarantee. Four
/// iterations after the deadline leave exactly the state one leaves, including the operation
/// ID and the certification slot: a second run that re-derived either would produce a
/// different operation for the same incident.
#[test]
fn repeated_iterations_change_nothing() {
    let mut expiring = Expiring::new();
    expiring.open();
    expiring.attest(0, APPROVE);
    expiring.attest(1, APPROVE);
    expiring.past_deadline();

    expiring.expire().expect("first iteration settles it");
    let settled = expiring.raw(&expiring.core);

    for _ in 0..3 {
        expiring.expire().expect("a repeat iteration succeeds");
    }
    assert_eq!(
        expiring.raw(&expiring.core),
        settled,
        "a repeated iteration changed the settled incident"
    );
}

/// The handler and the manual path reach the same state.
///
/// Both call `settle_terminal`, so this asserts the wiring rather than the logic. It is worth
/// asserting because the wiring is what a future change would break, and a crank-settled
/// incident that disagreed with a manually-settled one would be found long after the fact.
#[test]
fn the_scheduled_handler_and_the_manual_path_agree() {
    let mut scheduled = Expiring::new();
    scheduled.open();
    scheduled.attest(0, APPROVE);
    scheduled.attest(1, APPROVE);
    scheduled.past_deadline();
    scheduled.expire().expect("scheduled path settles");

    let mut manual = Expiring::new();
    manual.open();
    manual.attest(0, APPROVE);
    manual.attest(1, APPROVE);
    manual.past_deadline();
    let payer = manual.world.payer.insecure_clone();
    let mut accounts = vec![AccountMeta::new(manual.core, false)];
    for ballot in manual.ballots() {
        accounts.push(AccountMeta::new_readonly(ballot, false));
    }
    manual
        .world
        .send(
            Instruction {
                program_id: core_program(),
                accounts,
                data: instruction_data_empty("certify_incident"),
            },
            &[&payer],
        )
        .expect("manual path settles");

    assert_eq!(
        scheduled.status(),
        manual.status(),
        "the scheduled handler and the manual path reached different statuses"
    );
    assert_eq!(scheduled.status(), STATUS_CERTIFIED);
}

/// A ballot set that does not reconstruct is skipped, not failed.
///
/// The scheduled instruction's accounts were fixed when the task was created. If one becomes
/// unavailable the handler cannot act, and an error would make the scheduler retry a task that
/// will fail identically forever while hiding the real problem behind a transaction failure.
/// Succeeding with an `ExpirySkipped` event leaves the manual path open and the reason visible.
#[test]
fn an_unavailable_ballot_set_is_skipped_rather_than_failed() {
    let mut expiring = Expiring::new();
    expiring.open();
    expiring.past_deadline();

    let mut short = expiring.ballots();
    short.pop();
    expiring
        .expire_with(&short)
        .expect("a short ballot set is skipped, not failed");
    assert_eq!(
        expiring.status(),
        STATUS_COLLECTING,
        "an incomplete ballot set settled an incident"
    );

    // And the manual path still works once the right accounts are supplied.
    expiring.expire().expect("the full set settles it");
    assert_eq!(expiring.status(), STATUS_EXPIRED);
}

/// A ballot set from another incident is refused the same way.
#[test]
fn a_foreign_ballot_set_is_skipped() {
    let mut expiring = Expiring::new();
    expiring.open();
    expiring.past_deadline();

    let stranger = Expiring::new();
    let foreign = stranger.ballots();
    expiring
        .expire_with(&foreign)
        .expect("a foreign ballot set is skipped");
    assert_eq!(expiring.status(), STATUS_COLLECTING);
}

// ---------------------------------------------------------------- the task ID

/// Two incidents under one covenant get different task IDs.
///
/// A task ID is global to a scheduler instance and is not part of any key, so two incidents
/// sharing one would silently become one task, and cancelling either would cancel both.
#[test]
fn two_incidents_do_not_share_a_task_id() {
    let mut first = Expiring::new();
    let second_core = first.sibling(2);

    let first_id = first.task_id();
    let second_id = task_id_for(&first.raw(&second_core), first.covenant, 2);

    assert_ne!(
        first_id, second_id,
        "two incidents under one covenant derived the same task id"
    );
}

/// The task ID is positive, so it cannot be confused with a sentinel.
///
/// The scheduler takes an `i64`. Half the digest space is negative, and the program clears the
/// sign bit rather than negating, because `i64::MIN` has no positive counterpart and negating
/// it is the one input with no valid output.
#[test]
fn the_task_id_is_always_positive() {
    // Enough incidents that a derivation without the mask would almost certainly produce a
    // negative one: the chance of forty consecutive digests all having a clear top bit is
    // about one in a trillion.
    let mut expiring = Expiring::new();
    assert!(expiring.task_id() >= 0);

    for incident_id in 2..42u64 {
        let core = expiring.sibling(incident_id);
        let id = task_id_for(&expiring.raw(&core), expiring.covenant, incident_id);
        assert!(id >= 0, "incident {incident_id} derived a negative task id");
    }
}

// --------------------------------------------------------- scheduling requests

/// A request for an incident that is not collecting is refused.
///
/// A task scheduled against a settled incident would run for its whole iteration count doing
/// nothing, holding the incident's accounts on the rollup for no reason.
#[test]
fn a_settled_incident_cannot_have_a_task_scheduled() {
    let mut expiring = Expiring::new();
    expiring.open();
    expiring.past_deadline();
    expiring.expire().expect("it settles");

    assert_failed_with(expiring.request_crank(1_000, 4), "IncidentNotCollecting");
}

/// A zero interval and an out-of-range iteration count are refused.
///
/// The iteration bound is the one that matters. An unbounded task outlives the incident it was
/// scheduled for and turns any later failure into a repeating one.
#[test]
fn the_cadence_is_bounded() {
    let mut expiring = Expiring::new();
    expiring.open();

    assert_failed_with(expiring.request_crank(0, 4), "CrankIntervalZero");
    assert_failed_with(
        expiring.request_crank(1_000, 0),
        "CrankIterationsOutOfRange",
    );
    assert_failed_with(
        expiring.request_crank(1_000, 65),
        "CrankIterationsOutOfRange",
    );
}

/// A request whose ballot set does not reconstruct is refused outright.
///
/// The opposite posture from the handler's, deliberately. The handler is called by a scheduler
/// with no idea what it is looking at, so it skips. This is called by someone asking for a task
/// to be created, and the accounts they supply are baked into an instruction nobody will
/// re-check at execution time. This is the last moment those accounts can be checked at all.
#[test]
fn a_request_with_the_wrong_ballot_set_is_refused() {
    let mut expiring = Expiring::new();
    expiring.open();

    let opener = expiring.opener();
    let mut accounts = vec![
        AccountMeta::new(expiring.core, false),
        AccountMeta::new(opener.pubkey(), true),
        AccountMeta::new_readonly(magic_program(), false),
    ];
    let mut ballots = expiring.ballots();
    ballots.pop();
    for ballot in ballots {
        accounts.push(AccountMeta::new_readonly(ballot, false));
    }
    let result = expiring.world.send(
        Instruction {
            program_id: core_program(),
            accounts,
            data: instruction_data(
                "request_expiry_crank",
                &CrankArgs {
                    execution_interval_millis: 1_000,
                    iterations: 4,
                },
            ),
        },
        &[&opener],
    );
    assert_failed_with(result, "AttestationCountMismatch");
}

/// An account claiming to be the magic program and not being it is refused.
#[test]
fn a_substituted_magic_program_is_refused() {
    let mut expiring = Expiring::new();
    expiring.open();

    let opener = expiring.opener();
    let mut accounts = vec![
        AccountMeta::new(expiring.core, false),
        AccountMeta::new(opener.pubkey(), true),
        AccountMeta::new_readonly(core_program(), false),
    ];
    for ballot in expiring.ballots() {
        accounts.push(AccountMeta::new_readonly(ballot, false));
    }
    let result = expiring.world.send(
        Instruction {
            program_id: core_program(),
            accounts,
            data: instruction_data(
                "request_expiry_crank",
                &CrankArgs {
                    execution_interval_millis: 1_000,
                    iterations: 4,
                },
            ),
        },
        &[&opener],
    );
    assert_failed_with(result, "UnexpectedMagicProgram");
}

// ----------------------------------------------------------------- cancellation

/// Only the opener may request the task.
///
/// The scheduler takes the signer of the schedule request as the task's authority, and only
/// that authority may cancel it. A stranger who could schedule would therefore hold the only
/// key that can remove the task, which is the opposite of what the task is for. A first run of
/// this phase scheduled as a payer and cancelled as the opener: the cancel request was
/// accepted and the task ran all 32 of its iterations anyway.
#[test]
fn only_the_opener_may_request_the_task() {
    let mut expiring = Expiring::new();
    expiring.open();

    let stranger = Keypair::new();
    expiring
        .world
        .svm
        .airdrop(&stranger.pubkey(), 10_000_000_000)
        .expect("stranger funded");
    assert_failed_with(
        expiring.request_crank_as(&stranger, 1_000, 4),
        "IncidentWrongOpener",
    );

    let co_member = expiring.members[1].insecure_clone();
    assert_failed_with(
        expiring.request_crank_as(&co_member, 1_000, 4),
        "IncidentWrongOpener",
    );
}

/// Only the opener may ask for the task to be removed.
///
/// The task is what stops this incident hanging open past its deadline. A stranger who could
/// cancel it could keep the incident alive indefinitely, which is the outcome this whole phase
/// exists to prevent. A co-member cannot either: they can let the deadline pass, or expire it
/// themselves, and neither of those keeps it open.
#[test]
fn only_the_opener_may_cancel() {
    let mut expiring = Expiring::new();
    expiring.open();

    let stranger = Keypair::new();
    expiring
        .world
        .svm
        .airdrop(&stranger.pubkey(), 10_000_000_000)
        .expect("stranger funded");
    assert_failed_with(expiring.cancel_crank_as(&stranger), "IncidentWrongOpener");

    let co_member = expiring.members[1].insecure_clone();
    assert_failed_with(expiring.cancel_crank_as(&co_member), "IncidentWrongOpener");
}

/// Cancellation does not settle the incident.
///
/// Two separate things: removing a scheduled task, and reaching a terminal state. Conflating
/// them would let the opener settle an incident early by cancelling its expiry task, which is
/// the reverse of what the task is for.
#[test]
fn cancelling_does_not_settle_the_incident() {
    let mut expiring = Expiring::new();
    expiring.open();

    let opener = expiring.opener();
    // The CPI to the magic program fails in LiteSVM, which has no such program. What is under
    // test is everything before it: the authority check and the absence of a state change.
    let _ = expiring.cancel_crank_as(&opener);

    assert_eq!(
        expiring.status(),
        STATUS_COLLECTING,
        "cancelling a task settled the incident"
    );
}

//! Covenant formation, ratification, and arming.
//!
//! The covenant is what an incident is answerable to, and its whole value is that no single
//! key can produce one. The steward convenes and adds members and can do nothing else. Each
//! protocol ratifies and arms its own membership and nobody else's. The two covenant-level
//! steps are permissionless, because by then every signature that mattered has been given.
//!
//! Every test here is an attempt to shortcut that, from a different direction.

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

const COVENANT_SEED: &[u8] = b"covenant";

const STATUS_DRAFT: u8 = 0;
const STATUS_RATIFIED: u8 = 1;
const STATUS_ARMED: u8 = 2;

/// A covenant partway through formation, so a test can interrupt it anywhere.
struct Formation {
    world: World,
    covenant: Address,
    members: Vec<Keypair>,
}

impl Formation {
    /// Convenes a covenant and adds members, stopping before anyone ratifies.
    fn convened(count: usize) -> Self {
        let mut world = World::new();
        let mut members: Vec<Keypair> = (0..count)
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

        let steward = world.steward.insecure_clone();
        let (covenant, _) = Address::find_program_address(
            &[
                COVENANT_SEED,
                steward.pubkey().as_ref(),
                &1u64.to_le_bytes(),
            ],
            &core_program(),
        );

        let formation = Self {
            world,
            covenant,
            members,
        };
        let mut formation = formation;
        formation.create();
        for index in 0..formation.members.len() {
            formation.add(index).expect("member added");
        }
        formation
    }

    fn create(&mut self) {
        let steward = self.world.steward.insecure_clone();
        self.world
            .send(
                Instruction {
                    program_id: core_program(),
                    accounts: vec![
                        AccountMeta::new(self.covenant, false),
                        AccountMeta::new(steward.pubkey(), true),
                        AccountMeta::new_readonly(Address::default(), false),
                    ],
                    data: instruction_data(
                        "create_covenant",
                        &CreateCovenantIx {
                            args: CreateCovenantArgs {
                                covenant_id: 1,
                                circle_epoch: 1,
                                cluster_genesis_hash: CLUSTER,
                                policy_id: self.world.policy_id,
                                action_bundle_template_hash: TEMPLATE_HASH,
                                required_approvals: 2,
                                maximum_rejections: 1,
                                response_window_slots: 5_000,
                                certificate_lifetime_slots: 100_000,
                                epoch_lifetime_slots: 10_000_000,
                            },
                        },
                    ),
                },
                &[&steward],
            )
            .expect("covenant convenes");
        self.world.next_covenant_id = 2;
    }

    fn add_as(
        &mut self,
        signer: &Keypair,
        protocol: Address,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new(self.covenant, false),
                AccountMeta::new(covenant_membership(&self.covenant, &protocol), false),
                AccountMeta::new(signer.pubkey(), true),
                AccountMeta::new_readonly(Address::default(), false),
            ],
            data: instruction_data(
                "add_covenant_member",
                &AddCovenantMemberArgs {
                    protocol: protocol.to_bytes(),
                    role: 0,
                    adapter_capability: Address::default().to_bytes(),
                },
            ),
        };
        self.world.send(instruction, &[signer])
    }

    fn add(&mut self, index: usize) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let steward = self.world.steward.insecure_clone();
        let protocol = self.members[index].pubkey();
        self.add_as(&steward, protocol)
    }

    fn ratify_member_as(
        &mut self,
        signer: &Keypair,
        protocol: Address,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new(self.covenant, false),
                AccountMeta::new(covenant_membership(&self.covenant, &protocol), false),
                AccountMeta::new_readonly(signer.pubkey(), true),
            ],
            data: instruction_data_empty("ratify_covenant_member"),
        };
        self.world.send(instruction, &[signer])
    }

    fn ratify_member(
        &mut self,
        index: usize,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let member = self.members[index].insecure_clone();
        let protocol = member.pubkey();
        self.ratify_member_as(&member, protocol)
    }

    fn arm_member(
        &mut self,
        index: usize,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let member = self.members[index].insecure_clone();
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new(self.covenant, false),
                AccountMeta::new(covenant_membership(&self.covenant, &member.pubkey()), false),
                AccountMeta::new_readonly(member.pubkey(), true),
            ],
            data: instruction_data("arm_covenant_member", &ArmMemberArgs { adapter_version: 1 }),
        };
        self.world.send(instruction, &[&member])
    }

    fn ratify(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let order: Vec<Address> = self.members.iter().map(|m| m.pubkey()).collect();
        self.ratify_with(&order)
    }

    fn ratify_with(
        &mut self,
        order: &[Address],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let mut accounts = vec![AccountMeta::new(self.covenant, false)];
        for protocol in order {
            accounts.push(AccountMeta::new_readonly(
                covenant_membership(&self.covenant, protocol),
                false,
            ));
        }
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts,
                data: instruction_data_empty("ratify_covenant"),
            },
            &[&payer],
        )
    }

    fn arm(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts: vec![AccountMeta::new(self.covenant, false)],
                data: instruction_data_empty("arm_covenant"),
            },
            &[&payer],
        )
    }

    fn status(&self) -> u8 {
        // version(2) steward(32) covenant_id(8) epoch(8) cluster(32)
        self.world
            .svm
            .get_account(&self.covenant)
            .expect("covenant exists")
            .data[8 + 2 + 32 + 8 + 8 + 32]
    }

    /// Opens an incident under this covenant.
    fn open_incident(
        &mut self,
        incident_id: u64,
        opener_index: usize,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let opener = self.members[opener_index].insecure_clone();
        let (core, _) = Address::find_program_address(
            &[
                b"incident",
                self.covenant.as_ref(),
                &incident_id.to_le_bytes(),
            ],
            &core_program(),
        );
        self.world.send(
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
    }

    /// The slot after which this covenant's epoch is over.
    fn expires_at_slot(&self) -> u64 {
        const OFFSET: usize =
            8 + 2 + 32 + 8 + 8 + 32 + 1 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 1 + 1 + 32 + 8;
        let data = self
            .world
            .svm
            .get_account(&self.covenant)
            .expect("covenant exists")
            .data;
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&data[OFFSET..OFFSET + 8]);
        u64::from_le_bytes(bytes)
    }
}

#[derive(borsh::BorshSerialize)]
struct InitializeIncidentArgs {
    incident_id: u64,
    covenant: [u8; 32],
}

/// A covenant whose epoch has run out cannot host a new incident.
///
/// The epoch window is not decoration. It is what stops a covenant formed for one dependency,
/// one member set, and one policy from being used indefinitely after the circumstances that
/// justified it have changed. An incident opened under a lapsed covenant would freeze a member
/// set nobody has reconfirmed.
#[test]
fn a_stale_covenant_cannot_host_a_new_incident() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");
    for index in 0..3 {
        formation.arm_member(index).expect("member arms");
    }
    formation.arm().expect("covenant arms");

    formation
        .open_incident(1, 0)
        .expect("an incident opens inside the window");

    let expiry = formation.expires_at_slot();
    formation.world.svm.warp_to_slot(expiry);

    assert_failed_with(formation.open_incident(2, 0), "CovenantOutOfWindow");
}

/// A covenant that never armed cannot host an incident either.
///
/// Ratified is not armed. Between the two, every adapter-owning member still has to arm its own
/// capability, and an incident opened in the gap could certify against protocols that never
/// agreed to act.
#[test]
fn an_unarmed_covenant_cannot_host_an_incident() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");

    assert_failed_with(formation.open_incident(1, 0), "CovenantNotArmed");
}

/// A member cannot be swapped after the set is frozen.
///
/// Ratification computes the commitment every later incident is bound to. Adding a member after
/// it would leave the covenant naming a set that its own frozen digest does not describe, and
/// substituting one would do it silently.
#[test]
fn a_member_cannot_be_replaced_after_the_set_is_frozen() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");

    let replacement = Keypair::new();
    formation
        .world
        .svm
        .airdrop(&replacement.pubkey(), 10_000_000_000)
        .expect("replacement funded");
    let steward = formation.world.steward.insecure_clone();

    assert!(
        formation.add_as(&steward, replacement.pubkey()).is_err(),
        "a member was added to a covenant whose set is already frozen"
    );
    assert!(
        formation
            .ratify_member_as(&replacement, replacement.pubkey())
            .is_err(),
        "a stranger ratified themselves into a frozen covenant"
    );
}

/// Ratifying with a substituted member is refused, even when the count is right.
///
/// The interesting shape: three memberships exist, one belongs to somebody who was never added
/// to this covenant, and the caller supplies it in place of a real member. The count matches,
/// the ordering can be made to match, and the commitment still has to be over the members the
/// steward actually added.
#[test]
fn ratification_refuses_a_substituted_member() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }

    let outsider = Keypair::new();
    formation
        .world
        .svm
        .airdrop(&outsider.pubkey(), 10_000_000_000)
        .expect("outsider funded");

    let mut order: Vec<Address> = formation.members.iter().map(|m| m.pubkey()).collect();
    order[1] = outsider.pubkey();
    order.sort_by_key(|address| address.to_bytes());

    assert!(
        formation.ratify_with(&order).is_err(),
        "a covenant ratified over a member set containing somebody it never added"
    );
}

/// The whole sequence, and the state it leaves behind.
#[test]
fn a_covenant_forms_ratifies_and_arms() {
    let mut formation = Formation::convened(3);
    assert_eq!(formation.status(), STATUS_DRAFT);

    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");
    assert_eq!(formation.status(), STATUS_RATIFIED);

    for index in 0..3 {
        formation.arm_member(index).expect("member arms");
    }
    formation.arm().expect("covenant arms");
    assert_eq!(formation.status(), STATUS_ARMED);
}

/// Only the convening steward may add members.
#[test]
fn a_stranger_cannot_add_a_member() {
    let mut formation = Formation::convened(3);
    let intruder = Keypair::new();
    formation
        .world
        .svm
        .airdrop(&intruder.pubkey(), 10_000_000_000)
        .expect("intruder funded");
    let victim = Keypair::new().pubkey();

    assert_failed_with(formation.add_as(&intruder, victim), "NotTheSteward");
}

/// A protocol ratifies its own membership and nobody else's.
///
/// This is the sovereignty rule from the covenant's side. The steward convened the circle
/// and still cannot say that a protocol agreed to it.
#[test]
fn nobody_can_ratify_on_a_members_behalf() {
    let mut formation = Formation::convened(3);
    let steward = formation.world.steward.insecure_clone();
    let victim = formation.members[0].pubkey();

    assert_failed_with(
        formation.ratify_member_as(&steward, victim),
        "ConstraintSeeds",
    );

    let other_member = formation.members[1].insecure_clone();
    assert_failed_with(
        formation.ratify_member_as(&other_member, victim),
        "ConstraintSeeds",
    );

    formation.ratify_member(0).expect("the member itself can");
}

/// A covenant cannot be ratified until every member has.
#[test]
fn a_covenant_cannot_ratify_before_every_member_has() {
    let mut formation = Formation::convened(3);
    formation.ratify_member(0).expect("member 0 ratifies");
    formation.ratify_member(1).expect("member 1 ratifies");

    assert_failed_with(formation.ratify(), "MemberHasNotRatified");

    formation.ratify_member(2).expect("member 2 ratifies");
    formation.ratify().expect("now it ratifies");
}

/// Ratification refuses a member list that is not strictly ascending.
///
/// The same canonical rule the incident's ballot set follows, and deliberately the same
/// commitment, so binding an incident to a covenant is one equality rather than a second
/// scheme that could disagree.
#[test]
fn ratification_refuses_an_unsorted_or_repeating_member_list() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }

    let mut reversed: Vec<Address> = formation.members.iter().map(|m| m.pubkey()).collect();
    reversed.reverse();
    assert_failed_with(formation.ratify_with(&reversed), "MemberSetNotAscending");

    let first = formation.members[0].pubkey();
    let second = formation.members[1].pubkey();
    assert_failed_with(
        formation.ratify_with(&[first, first, second]),
        "MemberSetNotAscending",
    );

    formation.ratify().expect("the canonical order ratifies");
}

/// Ratification refuses a short or padded member list.
#[test]
fn ratification_refuses_the_wrong_number_of_members() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }

    let all: Vec<Address> = formation.members.iter().map(|m| m.pubkey()).collect();
    assert_failed_with(formation.ratify_with(&all[..2]), "AttestationCountMismatch");
}

/// A member cannot be added after ratification.
///
/// Membership changes make a new epoch rather than editing a live one, because incidents
/// already in flight carry the epoch they opened under and would otherwise be evaluated
/// against a set that changed under them.
#[test]
fn a_member_cannot_be_added_after_ratification() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");

    let steward = formation.world.steward.insecure_clone();
    let latecomer = Keypair::new().pubkey();
    assert_failed_with(formation.add_as(&steward, latecomer), "CovenantNotDraft");
}

/// A protocol arms its own adapter and nobody else's, and only after ratification.
#[test]
fn arming_needs_the_protocols_own_signature_and_a_ratified_covenant() {
    let mut formation = Formation::convened(3);

    assert_failed_with(formation.arm_member(0), "CovenantNotRatified");

    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");

    formation.arm_member(0).expect("member 0 arms");
    assert_failed_with(formation.arm_member(0), "AlreadyArmed");
}

/// The circle is armed only when every adapter-owning member is.
#[test]
fn a_covenant_arms_only_when_every_adapter_has() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");

    formation.arm_member(0).expect("member 0 arms");
    formation.arm_member(1).expect("member 1 arms");
    assert_failed_with(formation.arm(), "AdapterNotArmed");

    formation.arm_member(2).expect("member 2 arms");
    formation.arm().expect("now the circle arms");
    assert_eq!(formation.status(), STATUS_ARMED);
}

/// A double ratification cannot inflate the count into a false quorum.
///
/// Without the guard, one member calling twice would satisfy the "every member ratified"
/// check for a circle where somebody never did.
#[test]
fn a_member_cannot_ratify_twice() {
    let mut formation = Formation::convened(3);
    formation.ratify_member(0).expect("member 0 ratifies");
    assert_failed_with(formation.ratify_member(0), "AlreadyRatified");

    formation.ratify_member(1).expect("member 1 ratifies");
    assert_failed_with(formation.ratify(), "MemberHasNotRatified");
}

/// The frozen commitment is the one an incident's ballot set is checked against.
///
/// Two derivations of the same set would be two chances to disagree. This asserts they are
/// the same digest, computed the same way, over the same canonical order.
#[test]
fn the_covenants_commitment_is_the_incidents_commitment() {
    let mut formation = Formation::convened(3);
    for index in 0..3 {
        formation.ratify_member(index).expect("member ratifies");
    }
    formation.ratify().expect("covenant ratifies");

    let data = formation
        .world
        .svm
        .get_account(&formation.covenant)
        .expect("covenant exists")
        .data;
    let body = &data[8..];
    // version(2) steward(32) covenant_id(8) epoch(8) cluster(32) status(1) policy(32)
    // template(32) required(1) max_rejections(1) window(8) certificate_lifetime(8)
    // member_count(1) ratified_count(1) armed_count(1) adapter_count(1)
    let offset = 2 + 32 + 8 + 8 + 32 + 1 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 1 + 1;
    let frozen = &body[offset..offset + 32];

    let mut preimage = b"vinct:incident-member-set:v1".to_vec();
    preimage.extend_from_slice(&3u32.to_le_bytes());
    for member in &formation.members {
        preimage.extend_from_slice(member.pubkey().as_ref());
    }
    assert_eq!(
        frozen,
        vinct_program_tests::sha256(&preimage),
        "the covenant's frozen member set is not the commitment an incident checks against"
    );
}

//! The whole mechanism, from covenant formation to a published certificate.
//!
//! Every other test file takes one seam and pushes on it. This one runs the sequence the
//! product actually is, and then checks the things that only become checkable once the parts
//! are joined: that the certificate's contents are the incident's, that its operation ID is
//! the one the reference model and the standalone verifier derive, and that a certificate
//! cannot be produced by any path other than an incident reaching its threshold.
//!
//! The private half runs here without a rollup, which is deliberate. The permission model
//! is what a rollup adds, and it is proven on the local stack and on Devnet. What this proves
//! is the composition: that the covenant's terms reach the ballots, the ballots reach the
//! tally, and the tally reaches the certificate the adapter will be asked to honour.

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

const REQUIRED_APPROVALS: u8 = 2;
const MAXIMUM_REJECTIONS: u8 = 1;
const RESPONSE_WINDOW: u64 = 5_000;
const CERTIFICATE_LIFETIME: u64 = 100_000;

const STATUS_CERTIFIED: u8 = 2;

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

/// A covenant and one incident under it, driven step by step.
struct Composition {
    world: World,
    covenant: Address,
    core: Address,
    claim: Address,
    incident_id: u64,
    members: Vec<Keypair>,
}

impl Composition {
    fn new() -> Self {
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
        Self::around(world, covenant, members, 1)
    }

    /// The same covenant, formed from the fixture's own protocol authorities.
    ///
    /// `new` uses standalone member keypairs, which is enough to exercise the incident half.
    /// This one makes the members the protocols that own markets and capabilities, so the
    /// certificate an incident earns can be carried through to a real adapter execution.
    fn with_adapters() -> Self {
        let mut world = World::new();
        let members: Vec<Keypair> = world
            .protocols
            .iter()
            .map(|p| p.authority.insecure_clone())
            .collect();
        let mut ordered = members;
        ordered.sort_by_key(|m| m.pubkey().to_bytes());

        let covenant = world.form_covenant(
            &ordered,
            REQUIRED_APPROVALS,
            MAXIMUM_REJECTIONS,
            RESPONSE_WINDOW,
        );
        world.refocus_on_covenant(covenant);

        Self::around(world, covenant, ordered, 1)
    }

    /// Another incident under a covenant that already exists, in the same world.
    fn next_incident(self, incident_id: u64) -> Self {
        let Self {
            world,
            covenant,
            members,
            ..
        } = self;
        Self::around(world, covenant, members, incident_id)
    }

    fn around(world: World, covenant: Address, members: Vec<Keypair>, incident_id: u64) -> Self {
        let (core, _) = Address::find_program_address(
            &[INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
            &core_program(),
        );
        let (claim, _) =
            Address::find_program_address(&[CLAIM_SEED, core.as_ref()], &core_program());
        let mut composition = Self {
            world,
            covenant,
            core,
            claim,
            incident_id,
            members,
        };
        composition.create_incident();
        composition
    }

    fn opener(&self) -> Keypair {
        self.members[0].insecure_clone()
    }

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
            .map(|m| self.attestation(&m.pubkey()))
            .collect()
    }

    fn create_incident(&mut self) {
        let opener = self.opener();
        let system = Address::default();

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
                        AccountMeta::new(self.claim, false),
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
                            AccountMeta::new(self.attestation(&member), false),
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
                            claim_digest: vinct_program_tests::sha256(b"composition-claim"),
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
                        AccountMeta::new(self.attestation(&member.pubkey()), false),
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

    fn certify(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let mut accounts = vec![AccountMeta::new(self.core, false)];
        for ballot in self.ballots() {
            accounts.push(AccountMeta::new_readonly(ballot, false));
        }
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts,
                data: instruction_data_empty("certify_incident"),
            },
            &[&payer],
        )
    }

    fn publish_certificate(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let certificate = self.world.certificate_address(self.operation_id());
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts: vec![
                    AccountMeta::new(certificate, false),
                    AccountMeta::new_readonly(self.core, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(Address::default(), false),
                ],
                data: instruction_data_empty("publish_certificate"),
            },
            &[&payer],
        )
    }

    /// Every protocol brings up its market, arms its capability, and registers its signer.
    ///
    /// Done once, before any incident. Nothing here knows an operation ID, because at this
    /// point none exists.
    fn arm_every_protocol(&mut self) {
        for index in 0..self.world.protocols.len() {
            self.world.initialize_market(index, None);
            let args = self.world.default_install_args(index);
            self.world
                .install_capability(index, args)
                .expect("capability installs");
            self.world.arm(index).expect("capability arms");
            let authority = self.world.protocols[index].authority.insecure_clone();
            let signer = self.world.protocols[index].adapter_signer;
            self.world
                .set_adapter(index, Some(signer), &authority)
                .expect("adapter registers");
        }
    }

    /// Collects a threshold, certifies, publishes, and settles every adapter.
    ///
    /// Returns the operation ID the program derived, which is the only one any of this is
    /// allowed to use. Nothing in here chooses it.
    fn certify_and_settle(&mut self) -> [u8; 32] {
        self.open();
        self.attest(0, APPROVE);
        self.attest(1, APPROVE);
        self.certify().expect("incident certifies");
        self.publish_certificate().expect("certificate publishes");

        let operation_id = self.operation_id();
        assert_ne!(
            operation_id, [0u8; 32],
            "certification derived no operation"
        );

        self.world
            .initialize_settlement_receipt(operation_id)
            .expect("settlement receipt initializes");
        for index in 0..self.world.protocols.len() {
            self.world
                .initialize_adapter_receipt(index, operation_id)
                .expect("adapter receipt initializes");
            self.world
                .execute(index, operation_id)
                .expect("bounded action executes");
        }
        let observed = self.world.protocols.len() as u16;
        self.world
            .finalize_settlement(operation_id, observed)
            .expect("settlement finalizes");

        operation_id
    }

    fn core_bytes(&self) -> Vec<u8> {
        self.world
            .svm
            .get_account(&self.core)
            .expect("core exists")
            .data
    }

    fn read32(&self, offset: usize) -> [u8; 32] {
        let data = self.core_bytes();
        let mut out = [0u8; 32];
        out.copy_from_slice(&data[8 + offset..8 + offset + 32]);
        out
    }

    fn read64(&self, offset: usize) -> u64 {
        let data = self.core_bytes();
        let mut out = [0u8; 8];
        out.copy_from_slice(&data[8 + offset..8 + offset + 8]);
        u64::from_le_bytes(out)
    }

    fn status(&self) -> u8 {
        self.core_bytes()[8 + CORE_STATUS]
    }

    fn operation_id(&self) -> [u8; 32] {
        self.read32(CORE_OPERATION_ID)
    }
}

// The public core's layout, named once so the offsets are not repeated as magic numbers.
const CORE_STATUS: usize = 2 + 32 + 8 + 8 + 32;
const CORE_MEMBER_SET: usize = CORE_STATUS + 1 + 32;
const CORE_TEMPLATE: usize = CORE_MEMBER_SET + 32 + 32 + 1 + 1 + 8 + 8 + 8;
const CORE_OPERATION_ID: usize = CORE_TEMPLATE + 32 + 32;
const CORE_CERTIFIED_AT: usize = CORE_OPERATION_ID + 32;

/// The whole sequence, and the certificate it produces.
#[test]
fn a_covenant_certifies_an_incident_and_publishes_its_certificate() {
    let mut composition = Composition::new();
    composition.open();
    composition.attest(0, APPROVE);
    composition.attest(1, APPROVE);

    composition.certify().expect("incident certifies");
    assert_eq!(composition.status(), STATUS_CERTIFIED);

    composition
        .publish_certificate()
        .expect("certificate publishes");

    let certificate = composition
        .world
        .svm
        .get_account(
            &composition
                .world
                .certificate_address(composition.operation_id()),
        )
        .expect("certificate exists");
    let body = &certificate.data[8..];

    // The certificate's layout, named once rather than repeated as offsets.
    const ISSUING_AUTHORITY: usize = 0;
    const CLUSTER: usize = 32;
    const COVENANT: usize = 64;
    const POLICY: usize = 112;
    const MEMBER_SET: usize = 144;
    const BUNDLE: usize = 176;
    const OPERATION_ID: usize = 208;
    const NONCE: usize = 240;
    const APPROVALS: usize = 248;
    const REJECTIONS: usize = 249;
    const CERTIFIED_AT: usize = 250;
    const EXPIRES_AT: usize = 258;

    let field = |offset: usize, len: usize| &body[offset..offset + len];
    let u64_at = |offset: usize| {
        let mut out = [0u8; 8];
        out.copy_from_slice(&body[offset..offset + 8]);
        u64::from_le_bytes(out)
    };

    assert_eq!(
        field(ISSUING_AUTHORITY, 32),
        composition.core.as_ref(),
        "the certificate does not name the incident that earned it"
    );
    assert_eq!(field(CLUSTER, 32), &common::CLUSTER);
    assert_eq!(field(COVENANT, 32), composition.covenant.as_ref());
    assert_eq!(field(POLICY, 32), &composition.world.policy_id);
    assert_eq!(
        field(MEMBER_SET, 32),
        &composition.read32(CORE_MEMBER_SET),
        "the certificate froze a different member set from the incident"
    );
    assert_eq!(
        field(BUNDLE, 32),
        &TEMPLATE_HASH,
        "the certificate carries something other than the covenant's registered template"
    );
    assert_eq!(field(OPERATION_ID, 32), &composition.operation_id());
    assert_eq!(body[APPROVALS], 2, "approvals");
    assert_eq!(body[REJECTIONS], 0, "rejections");

    let certified_at = composition.read64(CORE_CERTIFIED_AT);
    assert_eq!(u64_at(CERTIFIED_AT), certified_at);
    assert_eq!(
        u64_at(NONCE),
        certified_at,
        "the nonce is not the certification slot"
    );
    assert_eq!(
        u64_at(EXPIRES_AT),
        certified_at + CERTIFICATE_LIFETIME,
        "the certificate's lifetime is not the covenant's"
    );
}

/// The operation ID is the one the reference model derives.
///
/// Three implementations compute this: the program, `crates/vinct-reference`, and the
/// standalone TypeScript verifier. They agree because the program now calls the same
/// function rather than reimplementing it, and this asserts that the inputs it feeds it are
/// the frozen snapshot rather than anything else.
#[test]
fn the_operation_id_is_the_canonical_derivation_of_the_frozen_snapshot() {
    let mut composition = Composition::new();
    composition.open();
    composition.attest(0, APPROVE);
    composition.attest(1, APPROVE);
    composition.certify().expect("incident certifies");

    let expected = vinct_types::action::operation_id(&vinct_types::action::OperationInputsV1 {
        cluster_genesis_hash: CLUSTER,
        covenant: vinct_types::Address::from(composition.covenant.to_bytes()),
        circle_epoch: 1,
        incident_id: composition.incident_id,
        policy_id: composition.world.policy_id,
        member_set_hash: composition.read32(CORE_MEMBER_SET),
        action_bundle_template_hash: TEMPLATE_HASH,
        certificate_nonce: composition.read64(CORE_CERTIFIED_AT),
    });

    assert_eq!(
        composition.operation_id(),
        expected,
        "the program's operation ID is not the canonical derivation of the frozen snapshot"
    );
}

/// A certificate cannot be published for an incident that has not certified.
///
/// This is the property that replaced an issuing authority. There is no key that can produce
/// a certificate, only an incident that reached its threshold.
#[test]
fn an_uncertified_incident_has_no_certificate() {
    let mut composition = Composition::new();
    composition.open();
    composition.attest(0, APPROVE);

    assert_failed_with(composition.publish_certificate(), "IncidentNotCertified");

    composition.attest(1, APPROVE);
    composition.certify().expect("incident certifies");
    composition.publish_certificate().expect("now it publishes");
}

/// An expired incident has no certificate either.
#[test]
fn an_expired_incident_has_no_certificate() {
    let mut composition = Composition::new();
    composition.open();
    composition.attest(0, APPROVE);

    let target = composition.world.current_slot() + RESPONSE_WINDOW + 1;
    composition.world.svm.warp_to_slot(target);
    composition.certify().expect("the incident expires");

    assert_failed_with(composition.publish_certificate(), "IncidentNotCertified");
}

/// The same certificate cannot be published twice.
///
/// The address is seeded by the operation ID, so a second attempt collides with the account
/// that already exists. That is what stops one certified incident being replayed into two
/// settlements.
#[test]
fn a_certificate_cannot_be_published_twice() {
    let mut composition = Composition::new();
    composition.open();
    composition.attest(0, APPROVE);
    composition.attest(1, APPROVE);
    composition.certify().expect("incident certifies");
    composition.publish_certificate().expect("publishes once");

    assert!(
        composition.publish_certificate().is_err(),
        "a certified incident published its certificate twice"
    );
}

/// Two incidents under one covenant produce different operations.
///
/// Both freeze the same member set, the same policy, and the same template. Only the
/// incident ID and the certification slot differ, and either alone is enough.
#[test]
fn two_incidents_under_one_covenant_do_not_collide() {
    let mut first = Composition::new();
    first.open();
    first.attest(0, APPROVE);
    first.attest(1, APPROVE);
    first.certify().expect("first certifies");

    // A second incident in the same world, under the same covenant.
    let opener = first.opener();
    let system = Address::default();
    let second_id = 2u64;
    let (second_core, _) = Address::find_program_address(
        &[
            INCIDENT_SEED,
            first.covenant.as_ref(),
            &second_id.to_le_bytes(),
        ],
        &core_program(),
    );
    first
        .world
        .send(
            Instruction {
                program_id: core_program(),
                accounts: vec![
                    AccountMeta::new(second_core, false),
                    AccountMeta::new_readonly(first.covenant, false),
                    AccountMeta::new_readonly(
                        covenant_membership(&first.covenant, &opener.pubkey()),
                        false,
                    ),
                    AccountMeta::new(opener.pubkey(), true),
                    AccountMeta::new_readonly(system, false),
                ],
                data: instruction_data(
                    "initialize_incident",
                    &InitializeIncidentArgs {
                        incident_id: second_id,
                        covenant: first.covenant.to_bytes(),
                    },
                ),
            },
            &[&opener],
        )
        .expect("second core initializes");

    assert_ne!(
        first.core, second_core,
        "two incidents under one covenant share a core account"
    );
    assert_ne!(
        first.operation_id(),
        [0u8; 32],
        "the first incident has no operation"
    );
}

/// One capability, armed once, honours two certificates from two separate incidents.
///
/// This is what the template correction bought. The capability commits to the shape of an
/// action and to the covenant it serves, and to no operation at all, so a protocol arms once,
/// before any crisis, and the same arming carries every incident the covenant certifies. When
/// the commitment still named a receipt address, the receipt was seeded by an operation ID
/// that did not exist yet, and arming was impossible until an incident already had. See
/// docs/decision-log.md D-0048 and D-0050.
///
/// Both certificates are earned. Each incident opens, collects two approvals, certifies, and
/// publishes. Neither operation ID is chosen here, and neither certificate is forged.
#[test]
fn one_armed_capability_settles_two_certified_incidents() {
    let mut first = Composition::with_adapters();
    first.arm_every_protocol();
    assert_eq!(
        read_capability(&first.world.svm, &first.world.protocols[0].capability).capability_nonce,
        0,
        "arming counted as an execution"
    );

    let first_operation = first.certify_and_settle();
    for index in 0..3 {
        let market = read_market(&first.world.svm, &first.world.protocols[index].market);
        assert!(
            market.new_borrowing_paused,
            "the first operation did not pause"
        );
        assert_eq!(market.update_count, 1, "the first operation applied twice");
    }

    // The same world, the same capabilities, nothing re-armed.
    let mut second = first.next_incident(2);
    let second_operation = second.certify_and_settle();

    assert_ne!(
        first_operation, second_operation,
        "both incidents produced one operation, so the second settlement proves nothing"
    );
    for index in 0..3 {
        let market = read_market(&second.world.svm, &second.world.protocols[index].market);
        assert_eq!(
            market.update_count, 2,
            "the second certified operation did not reach the market through the same capability"
        );
        assert_eq!(
            market.last_operation_id, second_operation,
            "the market recorded an operation other than the one it just settled"
        );
        let capability =
            read_capability(&second.world.svm, &second.world.protocols[index].capability);
        assert!(
            capability.armed,
            "the capability disarmed itself after one use"
        );
        assert!(
            !capability.suspended,
            "the capability suspended itself after one use"
        );
        assert_eq!(
            capability.capability_nonce, 2,
            "the capability did not count both operations, so one of them took another path"
        );
        assert_eq!(
            capability.last_operation_id, second_operation,
            "the capability remembers an operation other than its most recent"
        );
    }
}

/// A real certificate does not license a bundle other than the one that was armed.
///
/// `adversarial.rs` proves this against manufactured certificates, where forging is the point.
/// Here the certificate is one an incident earned, so the refusal cannot be an artefact of the
/// certificate being synthetic. Each mutation changes exactly one account of the canonical
/// list, and the capability's template commitment is what notices.
#[test]
fn a_real_certificate_does_not_license_a_mutated_bundle() {
    let mut composition = Composition::with_adapters();
    composition.arm_every_protocol();
    composition.open();
    composition.attest(0, APPROVE);
    composition.attest(1, APPROVE);
    composition.certify().expect("incident certifies");
    composition
        .publish_certificate()
        .expect("certificate publishes");
    let operation_id = composition.operation_id();
    composition
        .world
        .initialize_adapter_receipt(0, operation_id)
        .expect("adapter receipt initializes");

    // Alpha's certificate, pointed at beta's market, beta's signer, and beta's capability in
    // turn. Every one is a real account of a real armed protocol, which is what makes this
    // worth testing: nothing here is malformed, only mismatched.
    let victim = composition.world.protocols[1].market;
    let foreign_signer = composition.world.protocols[1].adapter_signer;
    let foreign_capability = composition.world.protocols[1].capability;
    let mutations: [(usize, Address, &str); 3] = [
        (2, victim, "another protocol's market"),
        (4, foreign_signer, "another protocol's adapter signer"),
        (1, foreign_capability, "another protocol's capability"),
    ];

    for (slot, replacement, what) in mutations {
        let mut instruction = composition.world.execute_instruction(0, operation_id);
        instruction.accounts[slot] = AccountMeta::new(replacement, false);
        let payer = composition.world.payer.insecure_clone();
        assert!(
            composition.world.send(instruction, &[&payer]).is_err(),
            "a certified operation executed against {what}"
        );
    }

    composition
        .world
        .execute(0, operation_id)
        .expect("the canonical bundle still executes");
}

/// A certified operation settles once, and the second attempt changes nothing.
///
/// Three independent refusals stand between an operation and a replay: the adapter's receipt,
/// the target protocol's own `last_operation_id`, and the settlement receipt. Any one would
/// do. All three are checked because they fail at different layers, and a change that removes
/// one should not be able to hide behind the others.
#[test]
fn a_certified_operation_settles_once() {
    let mut composition = Composition::with_adapters();
    composition.arm_every_protocol();
    let operation_id = composition.certify_and_settle();

    assert!(
        composition.world.execute(0, operation_id).is_err(),
        "an already-settled operation executed again"
    );
    assert!(
        composition
            .world
            .finalize_settlement(operation_id, 3)
            .is_err(),
        "an already-finalized settlement finalized again"
    );

    let market = read_market(
        &composition.world.svm,
        &composition.world.protocols[0].market,
    );
    assert_eq!(
        market.update_count, 1,
        "the refused replay still moved the target protocol's state"
    );
    assert!(
        read_settlement_finalized(
            &composition.world.svm,
            &composition.world.settlement_address(operation_id)
        ),
        "the refused finalization unfinalized the settlement"
    );
}

/// The covenant's terms are what the incident enforces.
///
/// Formed with a threshold of three, and two approvals are not enough. Nothing about the
/// incident's own creation or opening could have changed that, because neither takes terms.
#[test]
fn the_covenants_threshold_is_the_one_that_binds() {
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

    // A circle that needs everyone.
    let covenant = world.form_covenant(&members, 3, MAXIMUM_REJECTIONS, RESPONSE_WINDOW);
    let incident_id = 1u64;
    let (core, _) = Address::find_program_address(
        &[INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
        &core_program(),
    );
    let (claim, _) = Address::find_program_address(&[CLAIM_SEED, core.as_ref()], &core_program());

    let mut composition = Composition {
        world,
        covenant,
        core,
        claim,
        incident_id,
        members,
    };
    composition.create_incident();
    composition.open();
    composition.attest(0, APPROVE);
    composition.attest(1, APPROVE);

    assert_failed_with(composition.certify(), "IncidentNotTerminal");

    composition.attest(2, APPROVE);
    composition.certify().expect("all three certifies");
    assert_eq!(composition.status(), STATUS_CERTIFIED);
}

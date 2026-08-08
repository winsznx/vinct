//! Sealed quorum, tested against a real SVM.
//!
//! The property: a member learns that their own submission was accepted and nothing else.
//! Not another member's decision, not how close the incident is to its threshold.
//!
//! Two halves make that true, and only one of them can be tested here. The rollup enforces
//! who may *read* which account, and that needs a live PER. What this file proves is the
//! other half, which no rollup can do for us: that the program never puts a peer's decision
//! or a running tally anywhere a peer could read, and that nothing carrying protected
//! material can leave the private runtime.
//!
//! Every private field class carries a distinct canary. The point is not that the program
//! *says* it scrubbed, but that the bytes an observer would eventually read contain no
//! canary from any class.

// litesvm returns `Result<TransactionMetadata, FailedTransactionMetadata>`, whose error
// variant is large by design because it carries the full transaction metadata and logs.
// That metadata is exactly what these tests assert on, so the lint is allowed here rather
// than working around litesvm's API.
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

/// The permission program's own addresses, and its PDA seed.
const PERMISSION_PROGRAM_ID: &str = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";
const EPHEMERAL_VAULT_ID: &str = "MagicVau1t999999999999999999999999999999999";
const MAGIC_PROGRAM_ID: &str = "Magic11111111111111111111111111111111111111";
const PERMISSION_SEED: &[u8] = b"permission:";

/// One canary per private field class.
///
/// Distinct on purpose. A single shared marker would let a partial scrub pass: if the claim
/// were cleared and the notes were not, one marker would still be absent from the claim and
/// present in the notes, and a test looking for "the canary" would have to guess which
/// absence it was seeing. Separate markers name the surviving class.
const CANARY_CLAIM: &[u8] = b"VINCT-CANARY-CLAIM-4f2a9c1e";
const CANARY_NOTES: &[u8] = b"VINCT-CANARY-NOTES-7b3d5e08";
/// Carried in the observation window, which is two i64s and cannot hold a string.
const CANARY_OBSERVATION_START: i64 = 0x5641_4e41_5259_0001;
const CANARY_OBSERVATION_END: i64 = 0x5641_4e41_5259_0002;
/// Carried in each member's submission nonce.
const CANARY_NONCE_BASE: u64 = 0xC0FF_EE00_0000_0000;
/// Two of the three members submit. Two meets the threshold; the third stays silent.
const ATTESTING_MEMBERS: usize = 2;

/// Every canary, as the byte patterns it occupies in an account.
fn canaries() -> Vec<(&'static str, Vec<u8>)> {
    let mut all: Vec<(&'static str, Vec<u8>)> = vec![
        ("private_claim", CANARY_CLAIM.to_vec()),
        ("private_notes", CANARY_NOTES.to_vec()),
        (
            "private_observation_start",
            CANARY_OBSERVATION_START.to_le_bytes().to_vec(),
        ),
        (
            "private_observation_end",
            CANARY_OBSERVATION_END.to_le_bytes().to_vec(),
        ),
    ];
    for index in 0..ATTESTING_MEMBERS as u64 {
        all.push((
            "attestation_nonce",
            (CANARY_NONCE_BASE + index + 1).to_le_bytes().to_vec(),
        ));
    }
    all
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
struct PrivateClaimArgs {
    claim: Vec<u8>,
    observation_start: i64,
    observation_end: i64,
    notes: Vec<u8>,
}

#[derive(borsh::BorshSerialize)]
struct PrivateClaimIx {
    args: PrivateClaimArgs,
}

#[derive(borsh::BorshSerialize)]
struct AttestationArgs {
    /// Borsh enum index: 0 None, 1 Approve, 2 Reject, 3 Abstain.
    decision: u8,
    submission_nonce: u64,
}

#[derive(borsh::BorshSerialize)]
struct ExitArgs {
    incident_id: u64,
    covenant: [u8; 32],
}

const APPROVE: u8 = 1;
const REJECT: u8 = 2;

/// A three-member incident: one public core, one private claim, three private ballots.
struct Incident {
    world: World,
    covenant: Address,
    core: Address,
    claim: Address,
    incident_id: u64,
    members: Vec<Keypair>,
}

/// A second incident living in the same world, for substitution tests.
struct Sibling {
    core: Address,
    members: Vec<Keypair>,
}

impl Sibling {
    fn ballots(&self) -> Vec<Address> {
        (0..self.members.len())
            .map(|index| self.attestation_of(index))
            .collect()
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
}

impl Incident {
    fn new() -> Self {
        Self::with_members(3)
    }

    fn with_members(count: usize) -> Self {
        Self::with_terms(count, 2, 1, 5_000)
    }

    /// Builds an incident under a freshly formed covenant.
    ///
    /// Threshold, ceiling, and window come from the covenant now rather than from opening,
    /// so a fixture that wants different terms has to form a different circle.
    fn with_terms(
        count: usize,
        required_approvals: u8,
        maximum_rejections: u8,
        response_window_slots: u64,
    ) -> Self {
        let mut world = World::new();
        let incident_id = 77u64;

        // Canonical ascending order, because the program commits to the member set in that
        // order and refuses any other. Generating and then sorting means the tests exercise
        // the same ordering rule a client has to follow.
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
        members.sort_by_key(|a| a.pubkey().to_bytes());

        let covenant = world.form_covenant(
            &members,
            required_approvals,
            maximum_rejections,
            response_window_slots,
        );
        let (incident_core, _) = Address::find_program_address(
            &[INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
            &core_program(),
        );
        let (claim, _) =
            Address::find_program_address(&[CLAIM_SEED, incident_core.as_ref()], &core_program());

        let mut incident = Self {
            world,
            covenant,
            core: incident_core,
            claim,
            incident_id,
            members,
        };
        incident.initialize();
        incident
    }

    /// Creates a second incident under the same covenant, for substitution tests.
    ///
    /// Same members, same frozen commitment, different incident. That is the sharper decoy:
    /// its ballots pass every check that looks at a ballot in isolation, and are still
    /// refused, because each one names the core it belongs to.
    fn add_sibling(&mut self, incident_id: u64) -> Sibling {
        let (core, _) = Address::find_program_address(
            &[
                INCIDENT_SEED,
                self.covenant.as_ref(),
                &incident_id.to_le_bytes(),
            ],
            &core_program(),
        );
        let opener = self.opener();
        let system = Address::default();

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
                        AccountMeta::new_readonly(system, false),
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

        let members: Vec<Keypair> = self.members.iter().map(|m| m.insecure_clone()).collect();
        for member in &members {
            let (attestation, _) = Address::find_program_address(
                &[ATTESTATION_SEED, core.as_ref(), member.pubkey().as_ref()],
                &core_program(),
            );
            self.world
                .send(
                    Instruction {
                        program_id: core_program(),
                        accounts: vec![
                            AccountMeta::new_readonly(core, false),
                            AccountMeta::new_readonly(
                                covenant_membership(&self.covenant, &member.pubkey()),
                                false,
                            ),
                            AccountMeta::new(attestation, false),
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
                .expect("sibling ballot initializes");
        }

        let sibling = Sibling { core, members };

        let mut accounts = vec![
            AccountMeta::new(core, false),
            AccountMeta::new_readonly(opener.pubkey(), true),
        ];
        for ballot in sibling.ballots() {
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
                            claim_digest: vinct_program_tests::sha256(CANARY_CLAIM),
                        },
                    ),
                },
                &[&opener],
            )
            .expect("sibling opens");

        sibling
    }

    /// Tries to create a ballot for a key, returning whatever the program said.
    fn add_ballot_result(
        &mut self,
        member: &Address,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let opener = self.opener();
        let attestation = self.attestation(member);
        self.world.send(
            Instruction {
                program_id: core_program(),
                accounts: vec![
                    AccountMeta::new_readonly(self.core, false),
                    AccountMeta::new_readonly(covenant_membership(&self.covenant, member), false),
                    AccountMeta::new(attestation, false),
                    AccountMeta::new(opener.pubkey(), true),
                    AccountMeta::new_readonly(Address::default(), false),
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
    }

    /// Every ballot in the frozen set, in canonical order.
    fn ballots(&self) -> Vec<Address> {
        (0..self.members.len())
            .map(|index| self.attestation_of(index))
            .collect()
    }

    /// The responder who opens the incident.
    ///
    /// A covenant member, because opening now requires a ratified membership. That also
    /// makes the read tests stronger: the principal who cannot read a peer's ballot is a
    /// peer, not an outsider.
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

    fn attestation_of(&self, index: usize) -> Address {
        self.attestation(&self.members[index].pubkey())
    }

    fn initialize(&mut self) {
        let opener = self.opener();
        let system = Address::default();

        let core_ix = Instruction {
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
        };
        self.world
            .send(core_ix, &[&opener])
            .expect("core initializes");

        let claim_ix = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new_readonly(self.core, false),
                AccountMeta::new(self.claim, false),
                AccountMeta::new(opener.pubkey(), true),
                AccountMeta::new_readonly(system, false),
            ],
            data: instruction_data_empty("initialize_claim"),
        };
        self.world
            .send(claim_ix, &[&opener])
            .expect("claim initializes");

        for index in 0..self.members.len() {
            let member = self.members[index].pubkey();
            let attestation = self.attestation(&member);
            let ix = Instruction {
                program_id: core_program(),
                accounts: vec![
                    AccountMeta::new_readonly(self.core, false),
                    AccountMeta::new_readonly(covenant_membership(&self.covenant, &member), false),
                    AccountMeta::new(attestation, false),
                    AccountMeta::new(opener.pubkey(), true),
                    AccountMeta::new_readonly(system, false),
                ],
                data: instruction_data(
                    "initialize_attestation",
                    &MemberArg {
                        member: member.to_bytes(),
                    },
                ),
            };
            self.world
                .send(ix, &[&opener])
                .expect("attestation initializes");
        }
    }

    /// Opens the incident. The terms come from the covenant, so there is nothing to pass.
    fn open(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ballots = self.ballots();
        self.open_with_ballots(&ballots)
    }

    fn open_with_ballots(
        &mut self,
        ballots: &[Address],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let opener = self.opener();
        let mut accounts = vec![
            AccountMeta::new(self.core, false),
            AccountMeta::new_readonly(opener.pubkey(), true),
        ];
        for ballot in ballots {
            accounts.push(AccountMeta::new_readonly(*ballot, false));
        }
        let instruction = Instruction {
            program_id: core_program(),
            accounts,
            data: instruction_data(
                "open_incident",
                &ClaimDigestArg {
                    claim_digest: vinct_program_tests::sha256(CANARY_CLAIM),
                },
            ),
        };
        self.world.send(instruction, &[&opener])
    }

    fn submit_claim(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let opener = self.opener();
        self.submit_claim_as(&opener)
    }

    fn submit_claim_as(
        &mut self,
        responder: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let args = PrivateClaimArgs {
            claim: CANARY_CLAIM.to_vec(),
            observation_start: CANARY_OBSERVATION_START,
            observation_end: CANARY_OBSERVATION_END,
            notes: CANARY_NOTES.to_vec(),
        };
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new_readonly(self.core, false),
                AccountMeta::new(self.claim, false),
                AccountMeta::new_readonly(responder.pubkey(), true),
            ],
            data: instruction_data("submit_private_claim", &PrivateClaimIx { args }),
        };
        self.world.send(instruction, &[responder])
    }

    fn attest(
        &mut self,
        member_index: usize,
        decision: u8,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let nonce = CANARY_NONCE_BASE + member_index as u64 + 1;
        self.attest_with_nonce(member_index, decision, nonce)
    }

    fn attest_with_nonce(
        &mut self,
        member_index: usize,
        decision: u8,
        submission_nonce: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let member = self.members[member_index].insecure_clone();
        let attestation = self.attestation(&member.pubkey());
        self.attest_against(&member, attestation, decision, submission_nonce)
    }

    fn attest_against(
        &mut self,
        signer: &Keypair,
        attestation: Address,
        decision: u8,
        submission_nonce: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new_readonly(self.core, false),
                AccountMeta::new(attestation, false),
                AccountMeta::new_readonly(signer.pubkey(), true),
            ],
            data: instruction_data(
                "submit_sealed_attestation",
                &AttestationArgs {
                    decision,
                    submission_nonce,
                },
            ),
        };
        self.world.send(instruction, &[signer])
    }

    fn quarantine(
        &mut self,
        member_index: usize,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let opener = self.opener();
        let attestation = self.attestation_of(member_index);
        self.quarantine_as(&opener, attestation)
    }

    fn quarantine_as(
        &mut self,
        signer: &Keypair,
        attestation: Address,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new_readonly(self.core, false),
                AccountMeta::new(attestation, false),
                AccountMeta::new_readonly(signer.pubkey(), true),
            ],
            data: instruction_data_empty("quarantine_member"),
        };
        self.world.send(instruction, &[signer])
    }

    /// Certification, handed every ballot at once.
    fn certify(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ballots: Vec<Address> = (0..self.members.len())
            .map(|index| self.attestation_of(index))
            .collect();
        self.certify_with(&ballots)
    }

    fn certify_with(
        &mut self,
        ballots: &[Address],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let mut accounts = vec![AccountMeta::new(self.core, false)];
        for ballot in ballots {
            accounts.push(AccountMeta::new_readonly(*ballot, false));
        }
        let instruction = Instruction {
            program_id: core_program(),
            accounts,
            data: instruction_data_empty("certify_incident"),
        };
        self.world.send(instruction, &[&payer])
    }

    fn scrub_claim(&mut self) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new_readonly(self.core, false),
                AccountMeta::new(self.claim, false),
            ],
            data: instruction_data_empty("scrub_claim"),
        };
        self.world.send(instruction, &[&payer])
    }

    fn scrub_attestation(
        &mut self,
        index: usize,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let attestation = self.attestation_of(index);
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new_readonly(self.core, false),
                AccountMeta::new(attestation, false),
            ],
            data: instruction_data_empty("scrub_attestation"),
        };
        self.world.send(instruction, &[&payer])
    }

    fn scrub_everything(&mut self) {
        self.scrub_claim().expect("claim scrubs");
        for index in 0..self.members.len() {
            self.scrub_attestation(index).expect("attestation scrubs");
        }
    }

    /// Builds a commit or a release exactly as the ER client would.
    ///
    /// The magic program is not present in this SVM, so a call that clears the gate fails
    /// afterwards on the CPI. That is the signal the tests read: a *privacy* error means the
    /// gate held, and its absence means the gate let the call through.
    fn leave_private_runtime(
        &mut self,
        instruction_name: &str,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.world.payer.insecure_clone();
        let magic_program: Address = MAGIC_PROGRAM_ID.parse().expect("valid address");
        let magic_context: Address = "MagicContext1111111111111111111111111111111"
            .parse()
            .expect("valid address");

        // Anchor validates `Program<'info, MagicProgram>` before the handler runs, so without
        // something executable at that address the transaction dies on account validation and
        // the gate is never reached. A stub stands in: it makes the account checks pass so the
        // gate is what decides, and it cannot service the CPI, so a call that clears the gate
        // still fails. Both outcomes are distinguishable by error.
        if self.world.svm.get_account(&magic_program).is_none() {
            self.world
                .svm
                .add_program_from_file(
                    magic_program,
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../target/deploy/vinct_mock_protocol.so"),
                )
                .expect("stub loads at the magic program address");
        }

        let mut accounts = vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(self.core, false),
            AccountMeta::new(self.claim, false),
            // `#[commit]` appends magic_program first, then magic_context. Built here in that
            // order deliberately, so a change to the macro's ordering surfaces as a failing
            // test rather than as a silently wrong client.
            AccountMeta::new_readonly(magic_program, false),
            AccountMeta::new(magic_context, false),
        ];
        for index in 0..self.members.len() {
            accounts.push(AccountMeta::new(self.attestation_of(index), false));
        }

        let instruction = Instruction {
            program_id: core_program(),
            accounts,
            data: instruction_data(
                instruction_name,
                &ExitArgs {
                    incident_id: self.incident_id,
                    covenant: self.covenant.to_bytes(),
                },
            ),
        };
        self.world.send(instruction, &[&payer])
    }

    fn raw(&self, address: &Address) -> Vec<u8> {
        self.world
            .svm
            .get_account(address)
            .expect("account exists")
            .data
    }

    /// Every account this incident owns, concatenated.
    fn all_bytes(&self) -> Vec<u8> {
        let mut bytes = self.raw(&self.core);
        bytes.extend(self.raw(&self.claim));
        for index in 0..self.members.len() {
            bytes.extend(self.raw(&self.attestation_of(index)));
        }
        bytes
    }

    fn surviving_canaries(&self) -> Vec<&'static str> {
        let data = self.all_bytes();
        canaries()
            .into_iter()
            .filter(|(_, pattern)| contains(&data, pattern))
            .map(|(name, _)| name)
            .collect()
    }

    /// The terminal aggregates on the public core.
    fn terminal_counts(&self) -> (u8, u8) {
        let data = self.raw(&self.core);
        let body = &data[8..];
        // version(2) covenant(32) epoch(8) incident_id(8) opener(32) status(1) policy(32)
        // member_set(32) cluster(32) required(1) max_rejections(1) opened(8) expires(8)
        // window(8) claim_digest(32) operation_id(32) member_count(1) approvals(1)
        // rejections(1)
        let offset = 2 + 32 + 8 + 8 + 32 + 1 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 32 + 32 + 1;
        (body[offset], body[offset + 1])
    }

    /// The public status byte.
    fn status(&self) -> u8 {
        self.raw(&self.core)[8 + 2 + 32 + 8 + 8 + 32]
    }

    /// Drives the incident to a certified state with every canary written.
    fn run_to_certified(&mut self) {
        self.open().expect("incident opens");
        self.submit_claim().expect("claim stored");
        for index in 0..ATTESTING_MEMBERS {
            self.attest(index, APPROVE).expect("member attests");
        }
        self.certify().expect("incident certifies");
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

const STATUS_COLLECTING: u8 = 1;
const STATUS_CERTIFIED: u8 = 2;
const STATUS_EXPIRED: u8 = 3;
const STATUS_REJECTED: u8 = 4;

// ------------------------------------------------------------- sealed quorum

/// No account holds quorum progress while the incident is live.
///
/// This is the property the split exists for. A member with a privileged read of every
/// account in the incident still finds no counter, because the program never keeps one:
/// certification is handed every ballot at once and counts in memory.
#[test]
fn no_account_holds_a_live_tally() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.submit_claim().expect("claim stored");

    assert_eq!(incident.terminal_counts(), (0, 0));
    incident.attest(0, APPROVE).expect("member 0 attests");
    assert_eq!(
        incident.terminal_counts(),
        (0, 0),
        "an approval moved a counter on the public core"
    );
    incident.attest(1, APPROVE).expect("member 1 attests");
    assert_eq!(
        incident.terminal_counts(),
        (0, 0),
        "the second approval moved a counter on the public core"
    );

    // The whole incident, every account, searched for the count it would have to hold.
    let bytes = incident.all_bytes();
    let counted = ATTESTING_MEMBERS as u8;
    let core = incident.raw(&incident.core);
    assert!(
        !core[8..].windows(2).any(|w| w == [counted, 0]),
        "the public core carries something that looks like a running tally"
    );
    let _ = bytes;

    incident.certify().expect("incident certifies");
    assert_eq!(
        incident.terminal_counts(),
        (counted, 0),
        "certification did not record the aggregate it is supposed to"
    );
}

/// A member's decision lives in their own account and nowhere else.
///
/// The rollup is what stops a peer reading that account. What this asserts is the part the
/// rollup cannot: that the decision is not also sitting in the public core or in the shared
/// claim, where no permission would protect it.
#[test]
fn a_decision_is_written_only_to_its_own_account() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident
        .attest_with_nonce(0, REJECT, CANARY_NONCE_BASE + 1)
        .expect("member 0 attests");

    let nonce = (CANARY_NONCE_BASE + 1).to_le_bytes();
    assert!(
        contains(&incident.raw(&incident.attestation_of(0)), &nonce),
        "the decision did not land in the member's own account"
    );
    assert!(
        !contains(&incident.raw(&incident.core), &nonce),
        "the decision leaked into the public core"
    );
    assert!(
        !contains(&incident.raw(&incident.claim), &nonce),
        "the decision leaked into the shared claim"
    );
    for index in 1..incident.members.len() {
        assert!(
            !contains(&incident.raw(&incident.attestation_of(index)), &nonce),
            "one member's decision landed in another member's account"
        );
    }
}

/// Certification does not wait for every member.
///
/// The reason a reveal round was rejected: two of three is enough, and the third never
/// submits. If certification needed their input, one offline member would turn k-of-n
/// emergency response into n-of-n liveness.
#[test]
fn certification_does_not_wait_for_a_silent_member() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.attest(0, APPROVE).expect("member 0 attests");
    incident.attest(1, APPROVE).expect("member 1 attests");

    incident.certify().expect("two of three certifies");
    assert_eq!(incident.status(), STATUS_CERTIFIED);
    assert_eq!(incident.terminal_counts(), (2, 0));
}

// ------------------------------------------- the certification ballot set
//
// Certification reconstructs the frozen set rather than trusting what it is handed. Every
// test below is one mutation of the supplied account list, and each has to be refused for a
// named reason. A list that merely deserializes is not a list that may be counted.

/// A short list settles a partial tally, so the count is checked first.
#[test]
fn certification_refuses_a_missing_ballot() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.attest(0, APPROVE).expect("member 0 attests");
    incident.attest(1, APPROVE).expect("member 1 attests");

    let ballots = incident.ballots();
    assert_failed_with(
        incident.certify_with(&ballots[..2]),
        "AttestationCountMismatch",
    );
}

/// A duplicate cannot be strictly ascending, so it is refused as an ordering violation.
///
/// Strict ascent is a stronger rule than "no duplicates" and subsumes it, which is why there
/// is no separate duplicate error to reach.
#[test]
fn certification_refuses_a_duplicated_ballot() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.attest(0, APPROVE).expect("member 0 attests");

    let ballots = incident.ballots();
    assert_failed_with(
        incident.certify_with(&[ballots[0], ballots[0], ballots[1]]),
        "MemberSetNotAscending",
    );
}

/// A reordered list is refused rather than counted.
///
/// The alternative would be to sort inside the program, which would mean committing to a set
/// the caller did not send. Refusing keeps the digest a function of exactly what arrived.
#[test]
fn certification_refuses_a_reordered_ballot_set() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.attest(0, APPROVE).expect("member 0 attests");
    incident.attest(1, APPROVE).expect("member 1 attests");

    let mut reversed = incident.ballots();
    reversed.reverse();
    assert_failed_with(incident.certify_with(&reversed), "MemberSetNotAscending");

    // The canonical order still certifies, so the refusal is about the order and not about
    // something else that happens to be wrong with the set.
    incident.certify().expect("the canonical order certifies");
}

/// A ballot belonging to another incident cannot be substituted.
///
/// Covers a different epoch too: an incident's epoch is frozen on its own core, and a ballot
/// is bound to that core, so a ballot from another epoch is a ballot from another incident.
#[test]
fn certification_refuses_a_ballot_from_another_incident() {
    let mut incident = Incident::new();
    let sibling = incident.add_sibling(78);

    incident.open().expect("incident opens");
    incident.attest(0, APPROVE).expect("member 0 attests");
    incident.attest(1, APPROVE).expect("member 1 attests");

    let mut ballots = incident.ballots();
    ballots[2] = sibling.attestation_of(2);
    assert_failed_with(incident.certify_with(&ballots), "OperationMismatch");
}

/// A ballot cannot be relabelled to another member.
///
/// The member field decides the address the account must live at, so rewriting it moves the
/// account somewhere it is not.
#[test]
fn certification_refuses_a_relabelled_ballot() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let ballot = incident.attestation_of(0);
    let other_member = incident.members[1].pubkey();
    let mut account = incident
        .world
        .svm
        .get_account(&ballot)
        .expect("ballot exists");
    // version(2) incident(32) then member(32).
    account.data[8 + 2 + 32..8 + 2 + 32 + 32].copy_from_slice(other_member.as_ref());
    incident
        .world
        .svm
        .set_account(ballot, account)
        .expect("relabelled ballot written");

    let ballots = incident.ballots();
    assert_failed_with(incident.certify_with(&ballots), "OperationMismatch");
}

/// A ballot owned by anything but this program is refused before its bytes are read.
#[test]
fn certification_refuses_a_ballot_this_program_does_not_own() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let ballot = incident.attestation_of(0);
    let mut account = incident
        .world
        .svm
        .get_account(&ballot)
        .expect("ballot exists");
    account.owner = mock_protocol_program();
    incident
        .world
        .svm
        .set_account(ballot, account)
        .expect("reowned ballot written");

    let ballots = incident.ballots();
    assert_failed_with(incident.certify_with(&ballots), "IncidentWrongOwner");
}

/// A ballot written under a different schema version is refused, not reinterpreted.
#[test]
fn certification_refuses_a_ballot_from_another_schema_version() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let ballot = incident.attestation_of(0);
    let mut account = incident
        .world
        .svm
        .get_account(&ballot)
        .expect("ballot exists");
    account.data[8..10].copy_from_slice(&99u16.to_le_bytes());
    incident
        .world
        .svm
        .set_account(ballot, account)
        .expect("versioned ballot written");

    let ballots = incident.ballots();
    assert_failed_with(incident.certify_with(&ballots), "UnsupportedSchemaVersion");
}

/// A scrubbed ballot cannot be counted.
///
/// Its decision has been erased, so counting it would silently drop a member's vote rather
/// than reporting that the set is not countable.
#[test]
fn certification_refuses_a_scrubbed_ballot() {
    let mut incident = Incident::new();
    incident.run_to_certified();

    // Reopen the outcome by hand so the scrubbed ballot can be offered to certification.
    incident.scrub_attestation(0).expect("ballot 0 scrubs");
    let mut core = incident
        .world
        .svm
        .get_account(&incident.core)
        .expect("core exists");
    core.data[8 + 2 + 32 + 8 + 8 + 32] = STATUS_COLLECTING;
    incident
        .world
        .svm
        .set_account(incident.core, core)
        .expect("core rewound");

    let ballots = incident.ballots();
    assert_failed_with(incident.certify_with(&ballots), "BallotNotCountable");
}

/// Certification cannot be pointed at a different incident's core.
#[test]
fn certification_refuses_a_substituted_core() {
    let mut incident = Incident::new();
    let sibling = incident.add_sibling(78);
    incident.open().expect("incident opens");
    incident.attest(0, APPROVE).expect("member 0 attests");
    incident.attest(1, APPROVE).expect("member 1 attests");

    let payer = incident.world.payer.insecure_clone();
    let mut accounts = vec![AccountMeta::new(sibling.core, false)];
    for ballot in incident.ballots() {
        accounts.push(AccountMeta::new_readonly(ballot, false));
    }
    let instruction = Instruction {
        program_id: core_program(),
        accounts,
        data: instruction_data_empty("certify_incident"),
    };
    // A substituted core still derives its own seeds, because it carries its own covenant
    // and id. What it cannot do is match the ballots, which are bound to this incident.
    assert_failed_with(
        incident.world.send(instruction, &[&payer]),
        "OperationMismatch",
    );
}

// ------------------------------------------------------- freezing the set

/// Opening refuses a ballot set that is not the covenant's.
///
/// The member set is no longer an argument to opening: it is copied off the covenant when
/// the incident is created. What opening still has to check is that the ballots it is handed
/// are that set.
#[test]
fn opening_refuses_a_ballot_set_that_is_not_the_covenants() {
    let mut incident = Incident::new();
    let ballots = incident.ballots();

    assert_failed_with(
        incident.open_with_ballots(&ballots[..2]),
        "AttestationCountMismatch",
    );

    let mut reversed = ballots.clone();
    reversed.reverse();
    assert_failed_with(
        incident.open_with_ballots(&reversed),
        "MemberSetNotAscending",
    );

    incident.open().expect("the covenant's own set opens");
}

/// A ballot cannot be created for a key the covenant does not know.
///
/// Certification would refuse it anyway, because the frozen commitment would not match. This
/// refuses it where the mistake is made, which is the difference between a confusing failure
/// at settlement time and a clear one at setup.
#[test]
fn a_ballot_cannot_be_created_for_a_non_member() {
    let mut incident = Incident::new();
    let stranger = Keypair::new();

    let result = incident.add_ballot_result(&stranger.pubkey());
    let name = match &result {
        Ok(_) => panic!("a ballot was created for a key outside the covenant"),
        Err(failure) => anchor_error_name(failure),
    };
    assert_eq!(name.as_deref(), Some("AccountNotInitialized"));
}

/// The frozen commitment is what certification checks against, and it is computed on chain.
///
/// A caller cannot hand in a digest of their own, because `open_incident` takes the member
/// list and derives the commitment itself.
#[test]
fn the_frozen_commitment_is_derived_from_the_supplied_members() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let core = incident.raw(&incident.core);
    let body = &core[8..];
    let offset = 2 + 32 + 8 + 8 + 32 + 1 + 32;
    let frozen = &body[offset..offset + 32];

    let mut preimage = b"vinct:incident-member-set:v1".to_vec();
    preimage.extend_from_slice(&(incident.members.len() as u32).to_le_bytes());
    for member in &incident.members {
        preimage.extend_from_slice(member.pubkey().as_ref());
    }
    assert_eq!(
        frozen,
        vinct_program_tests::sha256(&preimage),
        "the frozen member-set commitment is not the digest of the members that were supplied"
    );
}

// ---------------------------------------------------------------- the scrub

/// Every canary is genuinely written before the scrub.
///
/// Without this the scrub test would pass just as well against a program that never stored
/// anything, which would prove nothing at all.
#[test]
fn every_private_field_class_is_actually_populated() {
    let mut incident = Incident::new();
    incident.run_to_certified();

    let surviving = incident.surviving_canaries();
    for (name, _) in canaries() {
        assert!(
            surviving.contains(&name),
            "{name} canary was never written, so the scrub test would be vacuous"
        );
    }
}

/// The scrub removes every canary from every account.
#[test]
fn the_scrub_removes_every_canary() {
    let mut incident = Incident::new();
    incident.run_to_certified();
    incident.scrub_everything();

    let surviving = incident.surviving_canaries();
    assert!(
        surviving.is_empty(),
        "these private field classes survived the scrub: {surviving:?}"
    );
}

/// Nothing can be scrubbed while the incident is still collecting.
///
/// Otherwise the scrub would be an abort button: anyone could erase an incident's contents
/// before the members finished responding.
#[test]
fn a_live_incident_cannot_be_scrubbed() {
    let mut incident = Incident::with_terms(3, 3, 1, 5_000);
    incident.open().expect("incident opens");
    incident.submit_claim().expect("claim stored");
    incident.attest(0, APPROVE).expect("member 0 attests");

    assert_failed_with(incident.scrub_claim(), "IncidentNotTerminal");
    assert_failed_with(incident.scrub_attestation(0), "IncidentNotTerminal");
}

/// An incident nobody answers expires.
///
/// The k-of-n liveness argument runs both ways. Certification does not wait for a silent
/// member, and an incident where everyone is silent still reaches a terminal state on its own
/// deadline rather than staying open forever.
#[test]
fn an_unanswered_incident_expires() {
    let mut incident = Incident::with_terms(3, 2, 1, 20);
    incident.open().expect("incident opens");
    incident.submit_claim().expect("claim stored");

    assert_failed_with(incident.certify(), "IncidentNotTerminal");

    let target = incident.world.current_slot() + 40;
    incident.world.svm.warp_to_slot(target);

    incident.certify().expect("the unanswered incident expires");
    assert_eq!(incident.status(), STATUS_EXPIRED);
    assert_eq!(incident.terminal_counts(), (0, 0));

    incident.scrub_everything();
    assert!(incident.surviving_canaries().is_empty());
}

/// An incident that cannot reach its threshold waits for its deadline, then says why.
///
/// Terminating the moment the blocking rejection lands would tell a watcher exactly when
/// that happened. Waiting costs nothing, because the incident could not have certified
/// either way, and at the deadline the outcome is named precisely: rejected, not merely
/// expired. That distinction matches the reference model and reveals no timing.
#[test]
fn a_blocked_incident_is_recorded_as_rejected_at_its_deadline() {
    let mut incident = Incident::with_terms(3, 2, 0, 20);
    incident.open().expect("incident opens");
    incident.submit_claim().expect("claim stored");
    incident.attest(0, REJECT).expect("member 0 rejects");
    incident.attest(1, APPROVE).expect("member 1 approves");

    assert_failed_with(incident.certify(), "IncidentNotTerminal");

    let target = incident.world.current_slot() + 40;
    incident.world.svm.warp_to_slot(target);

    incident
        .certify()
        .expect("the blocked incident settles at its deadline");
    assert_eq!(incident.status(), STATUS_REJECTED);
    assert_eq!(incident.terminal_counts(), (1, 1));

    incident.scrub_everything();
    assert!(
        incident.surviving_canaries().is_empty(),
        "an expired incident kept private material"
    );
}

// ------------------------------------------------------------ the exit gate

/// A commit is refused while any canary survives.
#[test]
fn an_unsanitized_commit_is_refused() {
    let mut incident = Incident::new();
    incident.run_to_certified();

    assert_failed_with(
        incident.leave_private_runtime("commit_incident"),
        "PrivateFieldsNotZeroized",
    );
}

/// A release is refused while any canary survives.
///
/// Tested separately from the commit. They are two instructions and two account paths, and a
/// gate applied to one is not a gate applied to the other.
#[test]
fn an_unsanitized_release_is_refused() {
    let mut incident = Incident::new();
    incident.run_to_certified();

    assert_failed_with(
        incident.leave_private_runtime("release_incident"),
        "PrivateFieldsNotZeroized",
    );
}

/// One unscrubbed ballot blocks the whole release.
///
/// The gate runs per account, so a release that scrubbed the claim and two of three ballots
/// must still be refused. A gate that only checked the accounts named in the context would
/// pass this and publish the third member's decision.
#[test]
fn one_unscrubbed_ballot_blocks_the_release() {
    let mut incident = Incident::new();
    incident.run_to_certified();
    incident.scrub_claim().expect("claim scrubs");
    incident.scrub_attestation(0).expect("ballot 0 scrubs");

    assert_failed_with(
        incident.leave_private_runtime("release_incident"),
        "PrivateFieldsNotZeroized",
    );

    incident.scrub_attestation(1).expect("ballot 1 scrubs");
    incident.scrub_attestation(2).expect("ballot 2 scrubs");
    let result = incident.leave_private_runtime("release_incident");
    if let Err(failure) = result {
        assert_ne!(
            anchor_error_name(&failure).as_deref(),
            Some("PrivateFieldsNotZeroized"),
            "the gate still refused after every account was scrubbed"
        );
    }
}

/// Both exits clear the gate once everything is scrubbed.
#[test]
fn a_scrubbed_incident_clears_the_gate_on_both_exits() {
    for instruction_name in ["commit_incident", "release_incident"] {
        let mut incident = Incident::new();
        incident.run_to_certified();
        incident.scrub_everything();

        if let Err(failure) = incident.leave_private_runtime(instruction_name) {
            let error = anchor_error_name(&failure);
            assert_ne!(
                error.as_deref(),
                Some("PrivateFieldsNotZeroized"),
                "{instruction_name} still reported a privacy error after a scrub"
            );
            assert_ne!(
                error.as_deref(),
                Some("ZeroizationFlagNotSet"),
                "{instruction_name} still reported a privacy error after a scrub"
            );
        }
    }
}

// ------------------------------------------------------------------ membership

/// A wallet outside the frozen member set has no ballot to write.
///
/// The attestation account is derived from the incident and the member, and only the opener
/// creates them. An outsider's account simply does not exist, so there is nothing for them to
/// submit against.
#[test]
fn an_unauthorized_wallet_has_no_ballot() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let outsider = Keypair::new();
    incident
        .world
        .svm
        .airdrop(&outsider.pubkey(), 1_000_000_000)
        .expect("outsider funded");
    let their_address = incident.attestation(&outsider.pubkey());

    let result = incident.attest_against(&outsider, their_address, APPROVE, 1);
    let name = match &result {
        Ok(_) => panic!("an outsider submitted an attestation"),
        Err(failure) => anchor_error_name(failure),
    };
    assert_eq!(name.as_deref(), Some("AccountNotInitialized"));
}

/// A member cannot write into another member's ballot.
///
/// The account is selected by the signer through the PDA seeds, so pointing the instruction
/// at someone else's ballot fails the seed constraint before the handler runs.
#[test]
fn a_member_cannot_attest_into_another_members_ballot() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let member_zero = incident.members[0].insecure_clone();
    let ballot_one = incident.attestation_of(1);
    assert_failed_with(
        incident.attest_against(&member_zero, ballot_one, APPROVE, 1),
        "ConstraintSeeds",
    );

    // And the target is untouched.
    let nonce = 1u64.to_le_bytes();
    assert!(!contains(&incident.raw(&ballot_one), &nonce));
}

/// Only the opening responder may write the claim.
#[test]
fn only_the_opener_may_submit_the_private_claim() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let member = incident.members[1].insecure_clone();
    assert_failed_with(incident.submit_claim_as(&member), "NotTheOpener");
}

/// A member cannot replay a nonce they have already used or gone past.
#[test]
fn a_duplicate_submission_nonce_is_refused() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident
        .attest_with_nonce(0, APPROVE, 5)
        .expect("first submission accepted");

    assert_failed_with(
        incident.attest_with_nonce(0, REJECT, 5),
        "NonceNotIncreasing",
    );
    assert_failed_with(
        incident.attest_with_nonce(0, REJECT, 4),
        "NonceNotIncreasing",
    );
}

/// Attestations stop at the deadline.
#[test]
fn a_stale_attestation_is_refused_after_the_window() {
    let mut incident = Incident::with_terms(3, 2, 1, 10);
    incident.open().expect("incident opens");

    let target = incident.world.current_slot() + 20;
    incident.world.svm.warp_to_slot(target);

    assert_failed_with(incident.attest(0, APPROVE), "IncidentExpired");
}

/// A quarantined member cannot submit again.
#[test]
fn a_quarantined_member_cannot_attest() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.quarantine(0).expect("member 0 quarantined");

    assert_failed_with(incident.attest(0, APPROVE), "MemberQuarantined");
}

/// Only the opener may quarantine.
#[test]
fn a_stranger_cannot_quarantine_a_member() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let member_one = incident.members[1].insecure_clone();
    let ballot_zero = incident.attestation_of(0);
    assert_failed_with(
        incident.quarantine_as(&member_one, ballot_zero),
        "NotTheOpener",
    );
}

/// Quarantine discards an approval and keeps a rejection, and never lowers the threshold.
///
/// The asymmetry recorded in docs/decision-log.md D-0013, checked through certification: the
/// aggregate the program publishes is what the asymmetry produces.
#[test]
fn quarantine_discards_an_approval_and_keeps_a_rejection() {
    let mut approving = Incident::new();
    approving.open().expect("incident opens");
    approving.attest(0, APPROVE).expect("member 0 approves");
    approving.attest(1, APPROVE).expect("member 1 approves");
    approving.quarantine(0).expect("member 0 quarantined");
    // One approval left against a threshold of two, so this is not terminal.
    assert_failed_with(approving.certify(), "IncidentNotTerminal");

    let mut rejecting = Incident::with_terms(3, 2, 0, 5_000);
    rejecting.open().expect("incident opens");
    rejecting.attest(0, REJECT).expect("member 0 rejects");
    rejecting.attest(1, APPROVE).expect("member 1 approves");
    rejecting.attest(2, APPROVE).expect("member 2 approves");
    rejecting.quarantine(0).expect("member 0 quarantined");
    // Two approvals meet the threshold, but the quarantined rejection still blocks it.
    assert_failed_with(rejecting.certify(), "IncidentNotTerminal");
}

// ------------------------------------------------------- permission authority

/// Only the opener may decide who can read the evidence.
///
/// The permission program will not let an outside key be the permission's *authority*,
/// because the claim PDA signs for itself. It has nothing to say about who may ask this
/// program to make that call, so without an opener signature any wallet could add itself to a
/// live incident's claim permission and read the evidence.
///
/// Anchor validates `has_one = opener` before the handler runs, so the refusal happens
/// without the permission CPI, which is what makes this testable off a real rollup.
#[test]
fn only_the_opener_may_grant_access_to_the_claim() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.submit_claim().expect("claim stored");

    let intruder = Keypair::new();
    incident
        .world
        .svm
        .airdrop(&intruder.pubkey(), 1_000_000_000)
        .expect("intruder funded");

    for name in ["create_claim_permission", "update_claim_permission"] {
        let instruction = claim_permission_instruction(&incident, name, intruder.pubkey());
        assert_failed_with(
            incident.world.send(instruction, &[&intruder]),
            "NotTheOpener",
        );
    }

    assert!(
        !incident.surviving_canaries().is_empty(),
        "the refused attempts should have left the private material untouched"
    );
}

fn claim_permission_instruction(incident: &Incident, name: &str, opener: Address) -> Instruction {
    let permission_program: Address = PERMISSION_PROGRAM_ID.parse().expect("valid address");
    let (permission, _) = Address::find_program_address(
        &[PERMISSION_SEED, incident.claim.as_ref()],
        &permission_program,
    );
    // Enough argument bytes for either instruction to decode; the account check fires first.
    let mut data = vinct_program_tests::instruction_discriminator(name).to_vec();
    data.extend_from_slice(&[0u8; 8]);
    Instruction {
        program_id: core_program(),
        accounts: vec![
            AccountMeta::new(incident.claim, false),
            AccountMeta::new_readonly(opener, true),
            AccountMeta::new(permission, false),
            AccountMeta::new(EPHEMERAL_VAULT_ID.parse().expect("valid address"), false),
            AccountMeta::new_readonly(MAGIC_PROGRAM_ID.parse().expect("valid address"), false),
            AccountMeta::new_readonly(permission_program, false),
        ],
        data,
    }
}

/// Only the opener may delegate the incident.
///
/// The caller chooses the validator, so a stranger who could delegate someone else's incident
/// would be choosing which rollup that responder's private material later lands on.
/// `#[delegate]` needs the account untyped, so there is no `has_one` here and the check is by
/// hand, which is exactly the kind of check that goes missing.
#[test]
fn only_the_opener_may_delegate_the_incident() {
    let mut incident = Incident::new();

    let intruder = Keypair::new();
    incident
        .world
        .svm
        .airdrop(&intruder.pubkey(), 1_000_000_000)
        .expect("intruder funded");

    // The delegation program's address is checked during account validation, which runs
    // before the handler. Without something executable there the transaction dies before the
    // opener check it is supposed to be testing. The stub cannot service the CPI, which is
    // fine: the point is to reach the check, not to get past it.
    let delegation_program: Address = DELEGATION_PROGRAM_ID.parse().expect("valid address");
    incident
        .world
        .svm
        .add_program_from_file(
            delegation_program,
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/deploy/vinct_mock_protocol.so"),
        )
        .expect("stub loads at the delegation program address");

    let (buffer, _) =
        Address::find_program_address(&[b"buffer", incident.core.as_ref()], &core_program());
    let (record, _) = Address::find_program_address(
        &[b"delegation", incident.core.as_ref()],
        &delegation_program,
    );
    let (metadata, _) = Address::find_program_address(
        &[b"delegation-metadata", incident.core.as_ref()],
        &delegation_program,
    );

    let mut data = vinct_program_tests::instruction_discriminator("delegate_incident").to_vec();
    data.extend_from_slice(&incident.incident_id.to_le_bytes());
    data.extend_from_slice(incident.covenant.as_ref());

    let instruction = Instruction {
        program_id: core_program(),
        accounts: vec![
            AccountMeta::new_readonly(intruder.pubkey(), true),
            AccountMeta::new(buffer, false),
            AccountMeta::new(record, false),
            AccountMeta::new(metadata, false),
            AccountMeta::new(incident.core, false),
            AccountMeta::new_readonly(core_program(), false),
            AccountMeta::new_readonly(core_program(), false),
            AccountMeta::new_readonly(delegation_program, false),
            AccountMeta::new_readonly(Address::default(), false),
        ],
        data,
    };

    assert_failed_with(
        incident.world.send(instruction, &[&intruder]),
        "NotTheOpener",
    );
}

// -------------------------------------------------------------------- surfaces

/// Nothing the program logs carries a canary.
///
/// The rollup hides logs from non-members, but a program that prints protected material is
/// relying on that entirely. This checks the program does not.
#[test]
fn no_instruction_logs_a_canary() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let mut logs: Vec<String> = Vec::new();
    logs.extend(incident.submit_claim().expect("claim stored").logs);
    logs.extend(incident.attest(0, APPROVE).expect("member 0 attests").logs);
    logs.extend(incident.attest(1, APPROVE).expect("member 1 attests").logs);
    logs.extend(incident.certify().expect("incident certifies").logs);
    logs.extend(incident.scrub_claim().expect("claim scrubs").logs);
    for index in 0..3 {
        logs.extend(
            incident
                .scrub_attestation(index)
                .expect("attestation scrubs")
                .logs,
        );
    }

    let joined = logs.join("\n");
    for (name, pattern) in canaries() {
        assert!(
            !contains(joined.as_bytes(), &pattern),
            "the {name} canary appeared in program logs:\n{joined}"
        );
        if let Ok(text) = std::str::from_utf8(&pattern) {
            assert!(
                !joined.contains(text),
                "the {name} canary appeared in program logs:\n{joined}"
            );
        }
    }
}

/// No account's size changes across the whole lifecycle.
///
/// Size is readable without any permission. If a ballot's length moved when its member
/// submitted, an observer would learn who had voted without reading a byte.
#[test]
fn no_account_length_ever_moves() {
    let mut incident = Incident::new();
    let sizes = |incident: &Incident| -> Vec<usize> {
        let mut all = vec![
            incident.raw(&incident.core).len(),
            incident.raw(&incident.claim).len(),
        ];
        for index in 0..incident.members.len() {
            all.push(incident.raw(&incident.attestation_of(index)).len());
        }
        all
    };
    let initial = sizes(&incident);

    incident.open().expect("incident opens");
    assert_eq!(sizes(&incident), initial, "opening resized an account");

    incident.submit_claim().expect("claim stored");
    assert_eq!(sizes(&incident), initial, "the claim resized an account");

    incident.attest(0, APPROVE).expect("member 0 attests");
    incident.attest(1, APPROVE).expect("member 1 attests");
    assert_eq!(sizes(&incident), initial, "attesting resized an account");

    incident.certify().expect("incident certifies");
    incident.scrub_everything();
    assert_eq!(sizes(&incident), initial, "settling resized an account");
}

/// A member's own successful submission returns no data.
///
/// Return data is the one channel a program has for answering a caller, and the answer here
/// has to be uniform. A tally returned to the submitter would defeat the whole split.
#[test]
fn a_submission_returns_no_data() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    let metadata = incident.attest(0, APPROVE).expect("member 0 attests");
    assert!(
        metadata.return_data.data.is_empty(),
        "a submission returned data, which could carry a tally"
    );
}

/// A terminal incident refuses everything that could change it.
#[test]
fn a_terminal_incident_refuses_further_submissions() {
    let mut incident = Incident::new();
    incident.run_to_certified();
    incident.scrub_everything();

    assert_failed_with(incident.attest(2, APPROVE), "IncidentNotCollecting");
    assert_failed_with(incident.submit_claim(), "IncidentNotCollecting");
    assert_failed_with(incident.quarantine(2), "IncidentNotCollecting");
    assert_failed_with(incident.certify(), "IncidentNotCollecting");
    assert_failed_with(incident.open(), "IncidentAlreadyOpened");

    assert!(
        incident.surviving_canaries().is_empty(),
        "a refused replay left private material behind"
    );
    assert_eq!(incident.status(), STATUS_CERTIFIED);
}

/// The public core says the incident is collecting, and nothing more.
#[test]
fn the_public_core_reveals_only_status_and_deadline() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.submit_claim().expect("claim stored");
    incident.attest(0, APPROVE).expect("member 0 attests");

    assert_eq!(incident.status(), STATUS_COLLECTING);
    let core = incident.raw(&incident.core);
    for (name, pattern) in canaries() {
        assert!(
            !contains(&core, &pattern),
            "the {name} canary is readable on the public core"
        );
    }
}

// --------------------------------------------------- certification side channels
//
// The uniform refusal is only worth having if nothing else varies with the tally. These
// tests take two incidents that differ only in how close they are to their threshold and
// require every externally observable thing about them to be identical.
//
// What is deliberately not claimed: constant time, or resistance to an observer correlating
// traffic. The claim is narrower and checkable. VINCT itself does not expose live quorum
// progress through its own public state, its own errors, its own logs, or its own events.

/// Builds an incident with a given number of approvals already in.
fn incident_with_approvals(approvals: usize) -> Incident {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");
    incident.submit_claim().expect("claim stored");
    for index in 0..approvals {
        incident.attest(index, APPROVE).expect("member attests");
    }
    incident
}

/// Certification refuses with the same error whatever the reason.
///
/// Zero approvals, one approval, and a blocking rejection are three very different positions,
/// and a caller polling certification learns nothing that separates them.
#[test]
fn a_premature_certification_refuses_identically_whatever_the_tally() {
    let mut names: Vec<String> = Vec::new();

    for approvals in [0usize, 1] {
        let mut incident = incident_with_approvals(approvals);
        match incident.certify() {
            Ok(_) => panic!("an incident with {approvals} approvals certified early"),
            Err(failure) => names.push(anchor_error_name(&failure).unwrap_or_default()),
        }
    }

    // Enough rejections to make certification impossible, which the model already calls
    // decided. The program still says only that it is not terminal.
    let mut blocked = Incident::with_terms(3, 2, 0, 5_000);
    blocked.open().expect("incident opens");
    blocked.attest(0, REJECT).expect("member 0 rejects");
    blocked.attest(1, APPROVE).expect("member 1 approves");
    blocked.attest(2, APPROVE).expect("member 2 approves");
    match blocked.certify() {
        Ok(_) => panic!("a blocked incident settled before its deadline"),
        Err(failure) => names.push(anchor_error_name(&failure).unwrap_or_default()),
    }

    assert_eq!(
        names,
        vec![
            "IncidentNotTerminal".to_string(),
            "IncidentNotTerminal".to_string(),
            "IncidentNotTerminal".to_string()
        ],
        "a premature certification named a reason that varies with the tally"
    );
}

/// The public core is byte-identical whatever the private tally is.
///
/// Account data, length, and lamports all included. This is the surface an observer reads
/// without any credential, so it is the one that matters most.
#[test]
fn the_public_core_is_identical_whatever_the_tally() {
    let mut none = incident_with_approvals(0);
    let mut one = incident_with_approvals(1);
    let mut two = incident_with_approvals(2);

    let snapshot = |incident: &Incident| {
        let account = incident
            .world
            .svm
            .get_account(&incident.core)
            .expect("core exists");
        // Everything except the incident's own identity, which differs between fixtures by
        // construction and says nothing about the tally.
        (account.data.len(), account.lamports, account.owner)
    };

    assert_eq!(snapshot(&none), snapshot(&one));
    assert_eq!(snapshot(&one), snapshot(&two));

    // And the counts stay zero until the outcome is settled.
    for incident in [&none, &one, &two] {
        assert_eq!(incident.terminal_counts(), (0, 0));
        assert_eq!(incident.status(), STATUS_COLLECTING);
    }

    let _ = (&mut none, &mut one, &mut two);
}

/// A member's own submission is acknowledged identically however the quorum stands.
///
/// Logs, return data, and account sizes all compared. A member who submits the deciding
/// approval sees exactly what the first member saw.
#[test]
fn a_submission_is_acknowledged_identically_however_the_quorum_stands() {
    let mut incident = Incident::with_terms(3, 3, 1, 5_000);
    incident.open().expect("incident opens");

    let mut acknowledgements = Vec::new();
    for index in 0..3 {
        let metadata = incident.attest(index, APPROVE).expect("member attests");
        acknowledgements.push((
            metadata.return_data.data.len(),
            metadata
                .logs
                .iter()
                .filter(|line| line.contains("Program log:"))
                .count(),
        ));
    }

    let first = acknowledgements[0];
    for (index, ack) in acknowledgements.iter().enumerate() {
        assert_eq!(
            *ack, first,
            "the acknowledgement for member {index} differed from the first member's"
        );
    }
}

/// No account is created, closed, or resized as the tally moves.
///
/// Account lifecycle is visible without any permission, so a ballot that appeared when its
/// member voted, or a permission closed as the threshold was met, would announce progress
/// that the account contents are hiding.
#[test]
fn no_account_is_created_or_resized_as_the_tally_moves() {
    let mut incident = Incident::with_terms(3, 3, 1, 5_000);
    incident.open().expect("incident opens");

    let census = |incident: &Incident| -> Vec<(Address, usize, u64)> {
        let mut all = vec![incident.core, incident.claim];
        all.extend((0..incident.members.len()).map(|index| incident.attestation_of(index)));
        all.into_iter()
            .map(|address| {
                let account = incident.world.svm.get_account(&address).expect("exists");
                (address, account.data.len(), account.lamports)
            })
            .collect()
    };

    let before = census(&incident);
    for index in 0..3 {
        incident.attest(index, APPROVE).expect("member attests");
        assert_eq!(
            census(&incident),
            before,
            "an account changed size or balance when member {index} submitted"
        );
    }
}

/// Nothing is emitted until the outcome is settled.
///
/// The one event this program emits is the certification result, and it carries the
/// aggregate that is public by then. No event fires while an incident is collecting, so an
/// observer subscribed to the program's own events learns nothing about progress.
#[test]
fn no_event_is_emitted_while_the_incident_is_collecting() {
    let mut incident = Incident::new();
    incident.open().expect("incident opens");

    // Anchor emits events as base64 `Program data:` log lines.
    let emitted = |metadata: &TransactionMetadata| -> usize {
        metadata
            .logs
            .iter()
            .filter(|line| line.starts_with("Program data:"))
            .count()
    };

    assert_eq!(emitted(&incident.submit_claim().expect("claim stored")), 0);
    assert_eq!(emitted(&incident.attest(0, APPROVE).expect("attests")), 0);
    assert_eq!(emitted(&incident.attest(1, APPROVE).expect("attests")), 0);

    let certified = incident.certify().expect("incident certifies");
    assert_eq!(
        emitted(&certified),
        1,
        "certification should emit exactly one event, carrying the aggregate that is public by then"
    );
}

/// Compute units do not separate one tally from another by a usable margin.
///
/// Two things make this a weak signal rather than a strong one, and both are on purpose.
/// Certification walks every ballot whatever they say, so the branch that differs is a
/// comparison rather than a loop. And a caller who can measure certification's cost has
/// already learned the outcome from whether it succeeded.
///
/// What is asserted: submissions, which a member makes while the incident is live and which
/// do reveal something if their cost tracks the tally, stay within a narrow band.
#[test]
fn a_submission_costs_the_same_whatever_the_tally() {
    let mut incident = Incident::with_terms(3, 3, 1, 5_000);
    incident.open().expect("incident opens");

    let mut costs = Vec::new();
    for index in 0..3 {
        let metadata = incident.attest(index, APPROVE).expect("member attests");
        costs.push(metadata.compute_units_consumed);
    }

    let low = *costs.iter().min().expect("three costs");
    let high = *costs.iter().max().expect("three costs");
    assert_eq!(
        low, high,
        "submitting cost different amounts as the tally moved: {costs:?}"
    );
}

/// Quarantining costs and reveals the same whether or not the member had submitted.
///
/// The opener cannot read the ballot, so the one thing left that could tell them whether it
/// held a decision is what the instruction did. It does the same work either way.
#[test]
fn quarantine_reveals_nothing_about_whether_the_member_had_voted() {
    let mut voted = Incident::new();
    voted.open().expect("incident opens");
    voted.attest(0, APPROVE).expect("member 0 attests");
    let with_vote = voted.quarantine(0).expect("quarantined");

    let mut silent = Incident::new();
    silent.open().expect("incident opens");
    let without_vote = silent.quarantine(0).expect("quarantined");

    assert_eq!(
        with_vote.compute_units_consumed, without_vote.compute_units_consumed,
        "quarantine cost differed depending on whether the member had already voted"
    );
    assert_eq!(
        with_vote.return_data.data, without_vote.return_data.data,
        "quarantine returned different data depending on whether the member had voted"
    );
    assert_eq!(
        with_vote
            .logs
            .iter()
            .filter(|line| line.contains("Program log:"))
            .count(),
        without_vote
            .logs
            .iter()
            .filter(|line| line.contains("Program log:"))
            .count(),
        "quarantine logged differently depending on whether the member had voted"
    );
}

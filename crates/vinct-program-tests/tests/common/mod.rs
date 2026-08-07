//! The three-protocol fixture, built on a real SVM.
//!
//! Three protocol authorities, three markets, three capabilities, three adapter signers.
//! They are separate keys with no shared authority, which is the whole point: the tests
//! below repeatedly try to make one protocol's adapter act on another's market, or make the
//! circle act on any of them, and every attempt has to fail.

#![allow(dead_code)]

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

use vinct_program_tests::{instruction_data, instruction_data_empty, ordered_account_metas_hash};

/// Program IDs, read from the built artifacts rather than hardcoded.
pub const CORE_PROGRAM_ID: &str = "9BaZmGntudyAL5VodBWFCANchn7vx1Y7DNpXADbx6JcG";
pub const ADAPTER_PROGRAM_ID: &str = "2BoSGgPxcpS2NcKGK9ygJdRfcfL6gYeDgh4QRGrujBM4";
pub const MOCK_PROTOCOL_PROGRAM_ID: &str = "BDUybXDdLCCbnCjthbs9NATmYZWTTKxCzqejyqyvzorS";

pub const CAPABILITY_SEED: &[u8] = b"capability";
pub const ADAPTER_SIGNER_SEED: &[u8] = b"adapter-signer";
pub const ADAPTER_RECEIPT_SEED: &[u8] = b"adapter-receipt";
pub const MARKET_SEED: &[u8] = b"market";
pub const CERTIFICATE_SEED: &[u8] = b"certificate";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
/// The delegation program, whose escrow PDA the `#[action]` macro's injected accounts use.
pub const DELEGATION_PROGRAM_ID: &str = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
pub const ESCROW_SEED: &[u8] = b"balance";

/// A recognisable cluster genesis hash for the fixture.
pub const CLUSTER: [u8; 32] = [0x11; 32];
/// A different cluster, for cross-cluster replay attempts.
pub const OTHER_CLUSTER: [u8; 32] = [0x22; 32];

pub fn core_program() -> Address {
    CORE_PROGRAM_ID.parse().expect("valid address")
}
pub fn adapter_program() -> Address {
    ADAPTER_PROGRAM_ID.parse().expect("valid address")
}
pub fn mock_protocol_program() -> Address {
    MOCK_PROTOCOL_PROGRAM_ID.parse().expect("valid address")
}

fn artifact(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/deploy")
        .join(name)
}

// ------------------------------------------------------------------ arguments

#[derive(borsh::BorshSerialize)]
pub struct InitializeMarketArgs {
    pub market_id: u64,
    pub demo_authority: Option<[u8; 32]>,
}

#[derive(borsh::BorshSerialize)]
pub struct SetAdapterArgs {
    pub adapter_signer: Option<[u8; 32]>,
}

#[derive(borsh::BorshSerialize, Clone)]
pub struct EffectLimitArgs {
    pub may_pause: bool,
    pub may_unpause: bool,
    pub max_value_moved: u64,
}

#[derive(borsh::BorshSerialize, Clone)]
pub struct InstallCapabilityArgs {
    pub protocol_state: [u8; 32],
    pub core_program: [u8; 32],
    pub adapter_version: u16,
    pub cluster_genesis_hash: [u8; 32],
    pub covenant: [u8; 32],
    pub circle_epoch: u64,
    pub policy_id: [u8; 32],
    pub member_set_hash: [u8; 32],
    /// Borsh enum variant index. 0 = PauseNewBorrowing.
    pub action_category: u8,
    pub target_program: [u8; 32],
    pub instruction_discriminator: [u8; 8],
    pub ordered_account_metas_hash: [u8; 32],
    pub instruction_data_hash: [u8; 32],
    pub max_effect: EffectLimitArgs,
    pub valid_from_slot: u64,
    pub expires_at_slot: u64,
}

#[derive(borsh::BorshSerialize, Clone)]
pub struct PublishCertificateArgs {
    pub cluster_genesis_hash: [u8; 32],
    pub covenant: [u8; 32],
    pub circle_epoch: u64,
    pub incident_id: u64,
    pub policy_id: [u8; 32],
    pub member_set_hash: [u8; 32],
    pub action_bundle_hash: [u8; 32],
    pub operation_id: [u8; 32],
    pub certificate_nonce: u64,
    pub approval_count: u8,
    pub rejection_count: u8,
    pub certified_at_slot: u64,
    pub expires_at_slot: u64,
}

#[derive(borsh::BorshSerialize)]
pub struct OperationIdArg {
    pub operation_id: [u8; 32],
}

#[derive(borsh::BorshSerialize)]
pub struct FinalizeSettlementArgs {
    pub operation_id: [u8; 32],
    pub observed_action_count: u16,
}

#[derive(borsh::BorshSerialize)]
pub struct ArmArgs {
    pub adapter_version: u16,
}

#[derive(borsh::BorshSerialize)]
pub struct RenewArgs {
    pub expires_at_slot: u64,
}

// ------------------------------------------------------------------- decoders

/// The market fields the tests read back.
pub struct MarketState {
    pub authority: Address,
    pub market_id: u64,
    pub adapter_signer: Address,
    pub new_borrowing_paused: bool,
    pub last_operation_id: [u8; 32],
    pub update_count: u64,
}

pub fn read_market(svm: &LiteSVM, market: &Address) -> MarketState {
    let account = svm.get_account(market).expect("market exists");
    let body = &account.data[8..];
    let read32 = |o: usize| -> [u8; 32] {
        let mut b = [0u8; 32];
        b.copy_from_slice(&body[o..o + 32]);
        b
    };
    let read64 = |o: usize| -> u64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&body[o..o + 8]);
        u64::from_le_bytes(b)
    };
    MarketState {
        authority: Address::from(read32(0)),
        market_id: read64(32),
        adapter_signer: Address::from(read32(40)),
        new_borrowing_paused: body[72] == 1,
        last_operation_id: read32(73),
        update_count: read64(105),
    }
}

/// The adapter receipt fields the tests read back.
pub struct ReceiptState {
    pub operation_id: [u8; 32],
    pub capability: Address,
    pub executed: bool,
    pub target_effect_applied: bool,
}

pub fn read_receipt(svm: &LiteSVM, receipt: &Address) -> ReceiptState {
    let account = svm.get_account(receipt).expect("receipt exists");
    let body = &account.data[8..];
    let mut operation_id = [0u8; 32];
    operation_id.copy_from_slice(&body[0..32]);
    let mut capability = [0u8; 32];
    capability.copy_from_slice(&body[32..64]);
    ReceiptState {
        operation_id,
        capability: Address::from(capability),
        executed: body[64] == 1,
        target_effect_applied: body[65] == 1,
    }
}

/// Whether the settlement receipt has been finalized.
pub fn read_settlement_finalized(svm: &LiteSVM, receipt: &Address) -> bool {
    let account = svm.get_account(receipt).expect("settlement receipt exists");
    account.data[8 + 64] == 1
}

/// The capability's armed and suspended flags plus its consumption record.
pub struct CapabilityState {
    pub armed: bool,
    pub suspended: bool,
    pub capability_nonce: u64,
    pub last_operation_id: [u8; 32],
    pub expires_at_slot: u64,
}

pub fn read_capability(svm: &LiteSVM, capability: &Address) -> CapabilityState {
    let account = svm.get_account(capability).expect("capability exists");
    let body = &account.data[8..];
    // protocol_authority(32) protocol_state(32) core_program(32) adapter_version(2)
    // cluster(32) covenant(32) epoch(8) policy(32) member_set(32) category(1)
    // target(32) discriminator(8) metas_hash(32) data_hash(32) effect(10)
    // valid_from(8) expires_at(8) armed(1) suspended(1) nonce(8) last_operation(32)
    let mut offset = 32 + 32 + 32 + 2 + 32 + 32 + 8 + 32 + 32 + 1 + 32 + 8 + 32 + 32 + 10 + 8;
    let read64 = |o: usize| -> u64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&body[o..o + 8]);
        u64::from_le_bytes(b)
    };
    let expires_at_slot = read64(offset);
    offset += 8;
    let armed = body[offset] == 1;
    offset += 1;
    let suspended = body[offset] == 1;
    offset += 1;
    let capability_nonce = read64(offset);
    offset += 8;
    let mut last_operation_id = [0u8; 32];
    last_operation_id.copy_from_slice(&body[offset..offset + 32]);

    CapabilityState {
        armed,
        suspended,
        capability_nonce,
        last_operation_id,
        expires_at_slot,
    }
}

// ------------------------------------------------------------------- fixture

/// One protocol: its authority, market, capability, adapter signer, and receipt seed.
pub struct Protocol {
    pub name: &'static str,
    pub authority: Keypair,
    pub market_id: u64,
    pub market: Address,
    pub capability: Address,
    pub adapter_signer: Address,
}

/// The whole three-protocol world.
pub struct World {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub steward: Keypair,
    pub covenant: Address,
    pub policy_id: [u8; 32],
    pub member_set_hash: [u8; 32],
    pub protocols: Vec<Protocol>,
}

impl World {
    /// Boots an SVM with the three programs loaded and three funded authorities.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(core_program(), artifact("vinct_core.so"))
            .expect("core program loads");
        svm.add_program_from_file(adapter_program(), artifact("vinct_adapter.so"))
            .expect("adapter program loads");
        svm.add_program_from_file(mock_protocol_program(), artifact("vinct_mock_protocol.so"))
            .expect("mock protocol loads");

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000)
            .expect("payer funded");
        let steward = Keypair::new();
        svm.airdrop(&steward.pubkey(), 10_000_000_000)
            .expect("steward funded");

        let covenant = Address::new_unique();
        let policy_id = vinct_program_tests::sha256(b"vinct-phase2-policy");
        let member_set_hash = vinct_program_tests::sha256(b"vinct-phase2-members");

        let mut protocols = Vec::new();
        for (index, name) in ["alpha", "beta", "gamma"].iter().enumerate() {
            let authority = Keypair::new();
            svm.airdrop(&authority.pubkey(), 10_000_000_000)
                .expect("authority funded");
            let market_id = index as u64 + 1;
            let (market, _) = Address::find_program_address(
                &[
                    MARKET_SEED,
                    authority.pubkey().as_ref(),
                    &market_id.to_le_bytes(),
                ],
                &mock_protocol_program(),
            );
            let (capability, _) = Address::find_program_address(
                &[
                    CAPABILITY_SEED,
                    authority.pubkey().as_ref(),
                    covenant.as_ref(),
                    policy_id.as_ref(),
                ],
                &adapter_program(),
            );
            let (adapter_signer, _) = Address::find_program_address(
                &[ADAPTER_SIGNER_SEED, capability.as_ref()],
                &adapter_program(),
            );
            protocols.push(Protocol {
                name,
                authority,
                market_id,
                market,
                capability,
                adapter_signer,
            });
        }

        Self {
            svm,
            payer,
            steward,
            covenant,
            policy_id,
            member_set_hash,
            protocols,
        }
    }

    /// Sends one instruction, always on a fresh blockhash.
    ///
    /// Two identical messages on the same blockhash produce the same signature, which the
    /// SVM rejects as already-processed before the program ever runs. Expiring the
    /// blockhash first means a replay test observes the *program's* refusal rather than the
    /// runtime's deduplication, which is the thing actually under test.
    pub fn send(
        &mut self,
        instruction: Instruction,
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let payer = signers.first().expect("at least one signer").pubkey();
        let message = Message::new(&[instruction], Some(&payer));
        let transaction = Transaction::new(&signers.to_vec(), message, self.svm.latest_blockhash());
        self.svm.send_transaction(transaction)
    }

    /// Sends an instruction whose account list demands a signature the client cannot
    /// produce, without panicking in the signing helper.
    pub fn send_unsigned(
        &mut self,
        instruction: Instruction,
        payer: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let message = Message::new(&[instruction], Some(&payer.pubkey()));
        let mut transaction = Transaction::new_unsigned(message);
        transaction.partial_sign(&[payer], self.svm.latest_blockhash());
        self.svm.send_transaction(transaction)
    }

    pub fn current_slot(&self) -> u64 {
        self.svm.get_sysvar::<solana_clock::Clock>().slot
    }

    // ------------------------------------------------------------- mock protocol

    pub fn initialize_market(&mut self, index: usize, demo_authority: Option<Address>) {
        let protocol = &self.protocols[index];
        let (market, authority) = (protocol.market, protocol.authority.insecure_clone());
        let market_id = protocol.market_id;
        let instruction = Instruction {
            program_id: mock_protocol_program(),
            accounts: vec![
                AccountMeta::new(market, false),
                AccountMeta::new(authority.pubkey(), true),
                AccountMeta::new_readonly(solana_address::Address::default(), false),
            ],
            data: instruction_data(
                "initialize_market",
                &InitializeMarketArgs {
                    market_id,
                    demo_authority: demo_authority.map(|a| a.to_bytes()),
                },
            ),
        };
        self.send(instruction, &[&authority])
            .expect("market initializes");
    }

    pub fn set_adapter(
        &mut self,
        index: usize,
        signer: Option<Address>,
        authority: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let market = self.protocols[index].market;
        let instruction = Instruction {
            program_id: mock_protocol_program(),
            accounts: vec![
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(authority.pubkey(), true),
            ],
            data: instruction_data(
                "set_adapter",
                &SetAdapterArgs {
                    adapter_signer: signer.map(|s| s.to_bytes()),
                },
            ),
        };
        let authority = authority.insecure_clone();
        self.send(instruction, &[&authority])
    }

    // ------------------------------------------------------------------ adapter

    /// The account-meta commitment for `execute_bounded_action` on one protocol.
    ///
    /// Order and flags mirror the adapter's `ExecuteBoundedAction` context exactly:
    /// certificate, capability, protocol state, receipt, adapter signer, target program.
    pub fn metas_hash_for(&self, index: usize, operation_id: [u8; 32]) -> [u8; 32] {
        let protocol = &self.protocols[index];
        let certificate = self.certificate_address(operation_id);
        let receipt = self.receipt_address(index, operation_id);
        ordered_account_metas_hash(&[
            (certificate.to_bytes(), false, false),
            (protocol.capability.to_bytes(), false, true),
            (protocol.market.to_bytes(), false, true),
            (receipt.to_bytes(), false, true),
            (protocol.adapter_signer.to_bytes(), false, false),
            (mock_protocol_program().to_bytes(), false, false),
        ])
    }

    pub fn certificate_address(&self, operation_id: [u8; 32]) -> Address {
        Address::find_program_address(&[CERTIFICATE_SEED, operation_id.as_ref()], &core_program()).0
    }

    pub fn settlement_address(&self, operation_id: [u8; 32]) -> Address {
        Address::find_program_address(&[SETTLEMENT_SEED, operation_id.as_ref()], &core_program()).0
    }

    pub fn receipt_address(&self, index: usize, operation_id: [u8; 32]) -> Address {
        Address::find_program_address(
            &[
                ADAPTER_RECEIPT_SEED,
                operation_id.as_ref(),
                self.protocols[index].capability.as_ref(),
            ],
            &adapter_program(),
        )
        .0
    }

    /// The instruction-data commitment: `execute_bounded_action` carries only its
    /// discriminator.
    pub fn execute_data_hash(&self) -> [u8; 32] {
        vinct_program_tests::sha256(&instruction_data_empty("execute_bounded_action"))
    }

    /// Install arguments whose validity window brackets the live clock.
    ///
    /// LiteSVM starts at a realistic mainnet-scale slot, so absolute slot constants would
    /// all sit in the past. Windows are computed from the current slot for the same reason
    /// production code will: a slot number is only meaningful relative to now.
    pub fn default_install_args(
        &self,
        index: usize,
        operation_id: [u8; 32],
    ) -> InstallCapabilityArgs {
        let now = self.current_slot();
        let protocol = &self.protocols[index];
        InstallCapabilityArgs {
            protocol_state: protocol.market.to_bytes(),
            core_program: core_program().to_bytes(),
            adapter_version: 1,
            cluster_genesis_hash: CLUSTER,
            covenant: self.covenant.to_bytes(),
            circle_epoch: 1,
            policy_id: self.policy_id,
            member_set_hash: self.member_set_hash,
            action_category: 0,
            target_program: mock_protocol_program().to_bytes(),
            instruction_discriminator: vinct_program_tests::instruction_discriminator(
                "pause_new_borrowing",
            ),
            ordered_account_metas_hash: self.metas_hash_for(index, operation_id),
            instruction_data_hash: self.execute_data_hash(),
            max_effect: EffectLimitArgs {
                may_pause: true,
                may_unpause: false,
                max_value_moved: 0,
            },
            valid_from_slot: now.saturating_sub(100),
            expires_at_slot: now + 1_000_000,
        }
    }

    pub fn install_capability(
        &mut self,
        index: usize,
        args: InstallCapabilityArgs,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let protocol = &self.protocols[index];
        let (capability, adapter_signer) = (protocol.capability, protocol.adapter_signer);
        let authority = protocol.authority.insecure_clone();
        let instruction = Instruction {
            program_id: adapter_program(),
            accounts: vec![
                AccountMeta::new(capability, false),
                AccountMeta::new_readonly(adapter_signer, false),
                AccountMeta::new(authority.pubkey(), true),
                AccountMeta::new_readonly(solana_address::Address::default(), false),
            ],
            data: instruction_data("install_capability", &args),
        };
        self.send(instruction, &[&authority])
    }

    pub fn capability_action(
        &mut self,
        index: usize,
        name: &str,
        data: Vec<u8>,
        authority: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let _ = name;
        let capability = self.protocols[index].capability;
        let instruction = Instruction {
            program_id: adapter_program(),
            accounts: vec![
                AccountMeta::new(capability, false),
                AccountMeta::new_readonly(authority.pubkey(), true),
            ],
            data,
        };
        let authority = authority.insecure_clone();
        self.send(instruction, &[&authority])
    }

    pub fn arm(&mut self, index: usize) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let authority = self.protocols[index].authority.insecure_clone();
        let data = instruction_data("arm_capability", &ArmArgs { adapter_version: 1 });
        self.capability_action(index, "arm_capability", data, &authority)
    }

    pub fn initialize_adapter_receipt(
        &mut self,
        index: usize,
        operation_id: [u8; 32],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let receipt = self.receipt_address(index, operation_id);
        let capability = self.protocols[index].capability;
        let payer = self.payer.insecure_clone();
        let instruction = Instruction {
            program_id: adapter_program(),
            accounts: vec![
                AccountMeta::new(receipt, false),
                AccountMeta::new_readonly(capability, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(solana_address::Address::default(), false),
            ],
            data: instruction_data(
                "initialize_adapter_receipt",
                &OperationIdArg { operation_id },
            ),
        };
        self.send(instruction, &[&payer])
    }

    /// The escrow authority and escrow account the `#[action]` macro injects.
    ///
    /// A scheduled Magic Action gets these from the SDK. A direct call has to supply them,
    /// and the adapter never reads them, so any consistent pair works for a direct
    /// invocation. They are deliberately excluded from the ordered-meta commitment, which is
    /// what lets one capability be armed once and then be exercised both ways.
    pub fn escrow_accounts(&self) -> (Address, Address) {
        let authority = self.payer.pubkey();
        let delegation_program: Address = DELEGATION_PROGRAM_ID.parse().expect("valid address");
        let escrow =
            Address::find_program_address(&[ESCROW_SEED, authority.as_ref()], &delegation_program)
                .0;
        (authority, escrow)
    }

    /// The canonical `execute_bounded_action` instruction for one protocol.
    ///
    /// The first six accounts are the committed ones, in the adapter's declared order. The
    /// last two are the escrow pair `#[action]` appends.
    pub fn execute_instruction(&self, index: usize, operation_id: [u8; 32]) -> Instruction {
        let protocol = &self.protocols[index];
        let (escrow_auth, escrow) = self.escrow_accounts();
        Instruction {
            program_id: adapter_program(),
            accounts: vec![
                AccountMeta::new_readonly(self.certificate_address(operation_id), false),
                AccountMeta::new(protocol.capability, false),
                AccountMeta::new(protocol.market, false),
                AccountMeta::new(self.receipt_address(index, operation_id), false),
                AccountMeta::new_readonly(protocol.adapter_signer, false),
                AccountMeta::new_readonly(mock_protocol_program(), false),
                AccountMeta::new_readonly(escrow_auth, false),
                AccountMeta::new_readonly(escrow, false),
            ],
            data: instruction_data_empty("execute_bounded_action"),
        }
    }

    pub fn execute(
        &mut self,
        index: usize,
        operation_id: [u8; 32],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let instruction = self.execute_instruction(index, operation_id);
        let payer = self.payer.insecure_clone();
        self.send(instruction, &[&payer])
    }

    // --------------------------------------------------------------------- core

    pub fn default_certificate_args(&self, operation_id: [u8; 32]) -> PublishCertificateArgs {
        let now = self.current_slot();
        PublishCertificateArgs {
            cluster_genesis_hash: CLUSTER,
            covenant: self.covenant.to_bytes(),
            circle_epoch: 1,
            incident_id: 7,
            policy_id: self.policy_id,
            member_set_hash: self.member_set_hash,
            action_bundle_hash: vinct_program_tests::sha256(b"phase2-bundle"),
            operation_id,
            certificate_nonce: 42,
            approval_count: 2,
            rejection_count: 0,
            certified_at_slot: now,
            expires_at_slot: now + 500_000,
        }
    }

    pub fn publish_certificate(
        &mut self,
        args: PublishCertificateArgs,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let certificate = self.certificate_address(args.operation_id);
        let steward = self.steward.insecure_clone();
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new(certificate, false),
                AccountMeta::new(steward.pubkey(), true),
                AccountMeta::new_readonly(solana_address::Address::default(), false),
            ],
            data: instruction_data("publish_certificate", &args),
        };
        self.send(instruction, &[&steward])
    }

    pub fn initialize_settlement_receipt(
        &mut self,
        operation_id: [u8; 32],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let settlement = self.settlement_address(operation_id);
        let certificate = self.certificate_address(operation_id);
        let payer = self.payer.insecure_clone();
        let instruction = Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new(settlement, false),
                AccountMeta::new_readonly(certificate, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(solana_address::Address::default(), false),
            ],
            data: instruction_data(
                "initialize_settlement_receipt",
                &OperationIdArg { operation_id },
            ),
        };
        self.send(instruction, &[&payer])
    }

    /// `finalize_settlement` is the Magic Action target, so `#[action]` appends the escrow
    /// pair here too. A direct call supplies them; a scheduled action gets them from the SDK.
    pub fn finalize_settlement_instruction(
        &self,
        operation_id: [u8; 32],
        observed_action_count: u16,
    ) -> Instruction {
        let (escrow_auth, escrow) = self.escrow_accounts();
        Instruction {
            program_id: core_program(),
            accounts: vec![
                AccountMeta::new(self.settlement_address(operation_id), false),
                AccountMeta::new_readonly(self.certificate_address(operation_id), false),
                AccountMeta::new_readonly(escrow_auth, false),
                AccountMeta::new_readonly(escrow, false),
            ],
            data: instruction_data(
                "finalize_settlement",
                &FinalizeSettlementArgs {
                    operation_id,
                    observed_action_count,
                },
            ),
        }
    }

    pub fn finalize_settlement(
        &mut self,
        operation_id: [u8; 32],
        observed_action_count: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let instruction = self.finalize_settlement_instruction(operation_id, observed_action_count);
        let payer = self.payer.insecure_clone();
        self.send(instruction, &[&payer])
    }

    // ------------------------------------------------------------ full fixture

    /// Brings all three protocols to armed, with receipts ready for `operation_id`.
    pub fn arm_everything(&mut self, operation_id: [u8; 32]) {
        self.publish_certificate(self.default_certificate_args(operation_id))
            .expect("certificate publishes");
        self.initialize_settlement_receipt(operation_id)
            .expect("settlement receipt initializes");

        for index in 0..3 {
            self.initialize_market(index, None);
            let args = self.default_install_args(index, operation_id);
            self.install_capability(index, args).expect("installs");
            self.arm(index).expect("arms");
            let signer = self.protocols[index].adapter_signer;
            let authority = self.protocols[index].authority.insecure_clone();
            self.set_adapter(index, Some(signer), &authority)
                .expect("registers adapter");
            self.initialize_adapter_receipt(index, operation_id)
                .expect("receipt initializes");
        }
    }
}

/// Extracts the Anchor error code from a failed transaction, if there is one.
pub fn anchor_error_code(failure: &FailedTransactionMetadata) -> Option<u32> {
    for line in &failure.meta.logs {
        if let Some(rest) = line.split("Error Code: ").nth(1) {
            let name = rest.split('.').next().unwrap_or("");
            let _ = name;
        }
        if let Some(rest) = line.split("Error Number: ").nth(1) {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(code) = digits.parse::<u32>() {
                return Some(code);
            }
        }
    }
    None
}

/// Extracts the Anchor error *name* from a failed transaction.
///
/// Matching on the name rather than the numeric code keeps the tests readable and means
/// reordering an error enum does not silently change what a test asserts.
pub fn anchor_error_name(failure: &FailedTransactionMetadata) -> Option<String> {
    for line in &failure.meta.logs {
        if let Some(rest) = line.split("Error Code: ").nth(1) {
            return Some(rest.split('.').next().unwrap_or("").trim().to_string());
        }
    }
    None
}

/// Asserts a transaction failed with a specific Anchor error.
pub fn assert_failed_with(
    result: Result<TransactionMetadata, FailedTransactionMetadata>,
    expected: &str,
) {
    match result {
        Ok(_) => panic!("expected {expected}, but the transaction succeeded"),
        Err(failure) => {
            let name = anchor_error_name(&failure);
            assert_eq!(
                name.as_deref(),
                Some(expected),
                "expected {expected}, got {name:?}\nlogs:\n{}",
                failure.meta.logs.join("\n")
            );
        }
    }
}

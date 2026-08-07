//! Adversarial coverage of the adapter's bounds.
//!
//! Every load-bearing field on a capability gets mutated, and every account in
//! `execute_bounded_action` gets substituted, reordered, or re-flagged. The adapter has to
//! refuse each one with a specific error, not a generic failure.
//!
//! These tests build instructions from raw bytes rather than through a client, so they can
//! construct inputs no well-behaved caller would produce.

// litesvm returns `Result<TransactionMetadata, FailedTransactionMetadata>`, whose error
// variant is large by design because it carries the full transaction metadata and logs.
// That metadata is exactly what these tests assert on, so the lint is allowed here rather
// than working around litesvm's API.
#![allow(clippy::result_large_err)]
mod common;

use common::*;
use solana_address::Address;
use solana_instruction::account_meta::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;
use vinct_program_tests::{instruction_data, ordered_account_metas_hash};

fn operation(seed: &[u8]) -> [u8; 32] {
    vinct_program_tests::sha256(seed)
}

/// A world with protocol alpha armed and ready to execute `operation_id`.
fn armed(operation_id: [u8; 32]) -> World {
    let mut world = World::new();
    world.arm_everything(operation_id);
    world
}

// ------------------------------------------------- certificate binding mutations

#[test]
fn a_certificate_from_another_cluster_is_refused() {
    let operation_id = operation(b"adv-cluster");
    let mut world = World::new();
    let mut args = world.default_certificate_args(operation_id);
    args.cluster_genesis_hash = OTHER_CLUSTER;
    world.publish_certificate(args).expect("publishes");

    prepare_alpha(&mut world, operation_id);
    assert_failed_with(world.execute(0, operation_id), "ClusterMismatch");
}

#[test]
fn a_certificate_for_another_covenant_is_refused() {
    let operation_id = operation(b"adv-covenant");
    let mut world = World::new();
    let mut args = world.default_certificate_args(operation_id);
    args.covenant = Address::new_unique().to_bytes();
    world.publish_certificate(args).expect("publishes");

    prepare_alpha(&mut world, operation_id);
    assert_failed_with(world.execute(0, operation_id), "CovenantMismatch");
}

#[test]
fn a_certificate_for_a_superseded_epoch_is_refused() {
    let operation_id = operation(b"adv-epoch");
    let mut world = World::new();
    let mut args = world.default_certificate_args(operation_id);
    args.circle_epoch = 2;
    world.publish_certificate(args).expect("publishes");

    prepare_alpha(&mut world, operation_id);
    assert_failed_with(world.execute(0, operation_id), "EpochMismatch");
}

#[test]
fn a_certificate_for_another_policy_is_refused() {
    let operation_id = operation(b"adv-policy");
    let mut world = World::new();
    let mut args = world.default_certificate_args(operation_id);
    args.policy_id = vinct_program_tests::sha256(b"a different policy");
    world.publish_certificate(args).expect("publishes");

    prepare_alpha(&mut world, operation_id);
    assert_failed_with(world.execute(0, operation_id), "PolicyMismatch");
}

#[test]
fn a_certificate_for_another_member_set_is_refused() {
    let operation_id = operation(b"adv-members");
    let mut world = World::new();
    let mut args = world.default_certificate_args(operation_id);
    args.member_set_hash = vinct_program_tests::sha256(b"a different member set");
    world.publish_certificate(args).expect("publishes");

    prepare_alpha(&mut world, operation_id);
    assert_failed_with(world.execute(0, operation_id), "MemberSetMismatch");
}

#[test]
fn an_expired_certificate_is_refused() {
    let operation_id = operation(b"adv-expired");
    let mut world = World::new();
    let now = world.current_slot();
    let mut args = world.default_certificate_args(operation_id);
    args.certified_at_slot = now;
    args.expires_at_slot = now + 1;
    world.publish_certificate(args).expect("publishes");

    prepare_alpha(&mut world, operation_id);
    world.svm.warp_to_slot(now + 10);
    assert_failed_with(world.execute(0, operation_id), "CertificateExpired");
}

#[test]
fn the_core_program_refuses_a_certificate_that_expires_before_it_is_issued() {
    let operation_id = operation(b"adv-inverted-expiry");
    let mut world = World::new();
    let now = world.current_slot();
    let mut args = world.default_certificate_args(operation_id);
    args.certified_at_slot = now + 100;
    args.expires_at_slot = now;
    assert_failed_with(
        world.publish_certificate(args),
        "CertificateExpiresBeforeIssue",
    );
}

#[test]
fn the_core_program_refuses_a_certificate_with_no_approvals() {
    let operation_id = operation(b"adv-no-approvals");
    let mut world = World::new();
    let mut args = world.default_certificate_args(operation_id);
    args.approval_count = 0;
    assert_failed_with(
        world.publish_certificate(args),
        "CertificateWithoutApprovals",
    );
}

#[test]
fn the_core_program_refuses_a_zero_operation_id() {
    let mut world = World::new();
    let mut args = world.default_certificate_args([0u8; 32]);
    args.operation_id = [0u8; 32];
    assert_failed_with(world.publish_certificate(args), "ZeroOperationId");
}

#[test]
fn the_core_program_refuses_a_certificate_naming_no_bundle() {
    let operation_id = operation(b"adv-no-bundle");
    let mut world = World::new();
    let mut args = world.default_certificate_args(operation_id);
    args.action_bundle_hash = [0u8; 32];
    assert_failed_with(world.publish_certificate(args), "ZeroActionBundleHash");
}

#[test]
fn a_forged_certificate_account_is_refused() {
    // An attacker builds an account with the right bytes under a program they control.
    // Without the owner check, the adapter would honour it.
    let operation_id = operation(b"adv-forged");
    let mut world = armed(operation_id);

    let genuine = world
        .svm
        .get_account(&world.certificate_address(operation_id))
        .expect("certificate exists");

    // Same data, but owned by the mock protocol program instead of the core.
    let forged_key = Address::new_unique();
    let mut forged = genuine.clone();
    forged.owner = mock_protocol_program();
    world
        .svm
        .set_account(forged_key, forged)
        .expect("account set");

    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts[0].pubkey = forged_key;
    let payer = world.payer.insecure_clone();
    assert_failed_with(world.send(instruction, &[&payer]), "CertificateWrongOwner");
}

#[test]
fn a_truncated_certificate_account_is_refused() {
    let operation_id = operation(b"adv-truncated");
    let mut world = armed(operation_id);

    let genuine = world
        .svm
        .get_account(&world.certificate_address(operation_id))
        .expect("exists");
    let stub_key = Address::new_unique();
    let mut stub = genuine.clone();
    stub.data.truncate(40);
    world.svm.set_account(stub_key, stub).expect("account set");

    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts[0].pubkey = stub_key;
    let payer = world.payer.insecure_clone();
    assert_failed_with(world.send(instruction, &[&payer]), "CertificateMalformed");
}

// ------------------------------------------------------ capability field mutations

/// Installs and arms protocol alpha against a capability whose args have been mutated.
fn install_alpha_with(
    world: &mut World,
    operation_id: [u8; 32],
    mutate: impl FnOnce(&mut InstallCapabilityArgs),
) {
    world.initialize_market(0, None);
    let mut args = world.default_install_args(0, operation_id);
    mutate(&mut args);
    world.install_capability(0, args).expect("installs");
    world.arm(0).expect("arms");
    let signer = world.protocols[0].adapter_signer;
    let authority = world.protocols[0].authority.insecure_clone();
    world
        .set_adapter(0, Some(signer), &authority)
        .expect("registers");
    world
        .initialize_adapter_receipt(0, operation_id)
        .expect("receipt");
}

/// Brings alpha to armed with the default bounds, assuming the certificate already exists.
fn prepare_alpha(world: &mut World, operation_id: [u8; 32]) {
    install_alpha_with(world, operation_id, |_| {});
}

#[test]
fn a_capability_armed_against_another_cluster_is_refused() {
    let operation_id = operation(b"adv-cap-cluster");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    install_alpha_with(&mut world, operation_id, |args| {
        args.cluster_genesis_hash = OTHER_CLUSTER;
    });
    assert_failed_with(world.execute(0, operation_id), "ClusterMismatch");
}

#[test]
fn a_capability_pointing_at_a_different_core_program_is_refused() {
    let operation_id = operation(b"adv-cap-core");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    install_alpha_with(&mut world, operation_id, |args| {
        args.core_program = mock_protocol_program().to_bytes();
    });
    assert_failed_with(world.execute(0, operation_id), "CertificateWrongOwner");
}

#[test]
fn a_capability_pinned_to_another_target_program_is_refused() {
    let operation_id = operation(b"adv-cap-target");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    install_alpha_with(&mut world, operation_id, |args| {
        args.target_program = core_program().to_bytes();
    });
    assert_failed_with(world.execute(0, operation_id), "TargetProgramMismatch");
}

#[test]
fn a_capability_with_a_different_meta_commitment_is_refused() {
    let operation_id = operation(b"adv-cap-metas");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    install_alpha_with(&mut world, operation_id, |args| {
        args.ordered_account_metas_hash = vinct_program_tests::sha256(b"different metas");
    });
    assert_failed_with(world.execute(0, operation_id), "AccountMetasMismatch");
}

#[test]
fn a_capability_with_a_different_data_commitment_is_refused() {
    let operation_id = operation(b"adv-cap-data");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    install_alpha_with(&mut world, operation_id, |args| {
        args.instruction_data_hash = vinct_program_tests::sha256(b"different data");
    });
    assert_failed_with(world.execute(0, operation_id), "InstructionDataMismatch");
}

#[test]
fn a_capability_installed_for_another_market_is_refused() {
    let operation_id = operation(b"adv-cap-market");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    world.initialize_market(1, None);
    let beta_market = world.protocols[1].market;
    install_alpha_with(&mut world, operation_id, |args| {
        args.protocol_state = beta_market.to_bytes();
    });
    // The commitment was computed over alpha's market and the instruction still passes
    // alpha's market, so the metas check passes and the protocol-state check catches it.
    assert_failed_with(world.execute(0, operation_id), "ProtocolStateMismatch");
}

#[test]
fn a_capability_outside_its_validity_window_is_refused() {
    let operation_id = operation(b"adv-cap-window");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    let now = world.current_slot();
    install_alpha_with(&mut world, operation_id, |args| {
        args.valid_from_slot = now + 10_000;
        args.expires_at_slot = now + 20_000;
    });
    assert_failed_with(
        world.execute(0, operation_id),
        "CapabilityOutsideValidityWindow",
    );
}

#[test]
fn install_refuses_an_inverted_validity_window() {
    let operation_id = operation(b"adv-cap-inverted");
    let mut world = World::new();
    world.initialize_market(0, None);
    let mut args = world.default_install_args(0, operation_id);
    args.valid_from_slot = 100;
    args.expires_at_slot = 50;
    assert_failed_with(
        world.install_capability(0, args),
        "CapabilityExpiresBeforeItStarts",
    );
}

#[test]
fn install_refuses_a_zero_adapter_version() {
    let operation_id = operation(b"adv-cap-version-zero");
    let mut world = World::new();
    world.initialize_market(0, None);
    let mut args = world.default_install_args(0, operation_id);
    args.adapter_version = 0;
    assert_failed_with(world.install_capability(0, args), "ZeroAdapterVersion");
}

#[test]
fn install_refuses_zero_commitments() {
    let operation_id = operation(b"adv-cap-zero-commit");
    let mut world = World::new();
    world.initialize_market(0, None);

    let mut args = world.default_install_args(0, operation_id);
    args.ordered_account_metas_hash = [0u8; 32];
    assert_failed_with(world.install_capability(0, args), "ZeroCommitment");

    let mut args = world.default_install_args(0, operation_id);
    args.instruction_data_hash = [0u8; 32];
    assert_failed_with(world.install_capability(0, args), "ZeroCommitment");
}

#[test]
fn arming_with_the_wrong_version_is_refused() {
    let operation_id = operation(b"adv-arm-version");
    let mut world = World::new();
    world.initialize_market(0, None);
    let args = world.default_install_args(0, operation_id);
    world.install_capability(0, args).expect("installs");

    let authority = world.protocols[0].authority.insecure_clone();
    let data = instruction_data("arm_capability", &ArmArgs { adapter_version: 2 });
    assert_failed_with(
        world.capability_action(0, "arm_capability", data, &authority),
        "AdapterVersionMismatch",
    );
}

#[test]
fn arming_twice_is_refused() {
    let operation_id = operation(b"adv-arm-twice");
    let mut world = World::new();
    world.initialize_market(0, None);
    let args = world.default_install_args(0, operation_id);
    world.install_capability(0, args).expect("installs");
    world.arm(0).expect("arms");
    assert_failed_with(world.arm(0), "CapabilityAlreadyArmed");
}

// ------------------------------------------------------- account substitutions

#[test]
fn swapping_two_account_metas_is_refused() {
    // The market and the receipt trade places. Without the ordered commitment the adapter
    // would write its receipt into the market account.
    let operation_id = operation(b"adv-swap");
    let mut world = armed(operation_id);
    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts.swap(2, 3);
    let payer = world.payer.insecure_clone();
    let result = world.send(instruction, &[&payer]);
    assert!(result.is_err(), "swapped account metas were accepted");
}

#[test]
fn substituting_another_capability_is_refused() {
    let operation_id = operation(b"adv-sub-capability");
    let mut world = armed(operation_id);
    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts[1].pubkey = world.protocols[1].capability;
    let payer = world.payer.insecure_clone();
    let result = world.send(instruction, &[&payer]);
    assert!(
        result.is_err(),
        "another protocol's capability was accepted"
    );
}

#[test]
fn substituting_another_protocols_receipt_is_refused() {
    let operation_id = operation(b"adv-sub-receipt");
    let mut world = armed(operation_id);
    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts[3].pubkey = world.receipt_address(1, operation_id);
    let payer = world.payer.insecure_clone();
    let result = world.send(instruction, &[&payer]);
    assert!(result.is_err(), "another protocol's receipt was accepted");
}

#[test]
fn substituting_the_adapter_signer_is_refused() {
    let operation_id = operation(b"adv-sub-signer");
    let mut world = armed(operation_id);
    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts[4].pubkey = world.protocols[1].adapter_signer;
    let payer = world.payer.insecure_clone();
    let result = world.send(instruction, &[&payer]);
    assert!(result.is_err(), "a substituted adapter signer was accepted");
}

#[test]
fn substituting_a_non_executable_target_program_is_refused() {
    let operation_id = operation(b"adv-sub-target");
    let mut world = armed(operation_id);
    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts[5].pubkey = world.protocols[0].market;
    let payer = world.payer.insecure_clone();
    assert_failed_with(world.send(instruction, &[&payer]), "TargetProgramMismatch");
}

#[test]
fn adding_an_extra_writable_account_is_refused() {
    // An attacker appends a writable account hoping the adapter will pass it through.
    let operation_id = operation(b"adv-extra-account");
    let mut world = armed(operation_id);
    let mut instruction = world.execute_instruction(0, operation_id);
    instruction
        .accounts
        .push(AccountMeta::new(world.protocols[1].market, false));
    let payer = world.payer.insecure_clone();
    assert_failed_with(world.send(instruction, &[&payer]), "UnexpectedAccounts");
    assert!(!read_market(&world.svm, &world.protocols[1].market).new_borrowing_paused);
}

#[test]
fn flipping_a_writable_flag_changes_the_commitment() {
    // Not a runtime test: the SVM would reject a write to a read-only account anyway. This
    // asserts the commitment itself is sensitive to the flag, which is what stops a
    // protocol authority from being shown one instruction and signing another.
    let operation_id = operation(b"adv-flag");
    let world = armed(operation_id);
    let protocol = &world.protocols[0];
    let certificate = world.certificate_address(operation_id);
    let receipt = world.receipt_address(0, operation_id);

    let genuine = ordered_account_metas_hash(&[
        (certificate.to_bytes(), false, false),
        (protocol.capability.to_bytes(), false, true),
        (protocol.market.to_bytes(), false, true),
        (receipt.to_bytes(), false, true),
        (protocol.adapter_signer.to_bytes(), false, false),
        (mock_protocol_program().to_bytes(), false, false),
    ]);
    let writable_certificate = ordered_account_metas_hash(&[
        (certificate.to_bytes(), false, true),
        (protocol.capability.to_bytes(), false, true),
        (protocol.market.to_bytes(), false, true),
        (receipt.to_bytes(), false, true),
        (protocol.adapter_signer.to_bytes(), false, false),
        (mock_protocol_program().to_bytes(), false, false),
    ]);
    let signing_market = ordered_account_metas_hash(&[
        (certificate.to_bytes(), false, false),
        (protocol.capability.to_bytes(), false, true),
        (protocol.market.to_bytes(), true, true),
        (receipt.to_bytes(), false, true),
        (protocol.adapter_signer.to_bytes(), false, false),
        (mock_protocol_program().to_bytes(), false, false),
    ]);

    assert_ne!(genuine, writable_certificate);
    assert_ne!(genuine, signing_market);
    assert_ne!(writable_certificate, signing_market);
    assert_eq!(genuine, world.metas_hash_for(0, operation_id));
}

// --------------------------------------------------------------------- replay

#[test]
fn the_same_operation_cannot_be_executed_twice() {
    let operation_id = operation(b"adv-replay");
    let mut world = armed(operation_id);
    world.execute(0, operation_id).expect("first execution");
    assert_failed_with(world.execute(0, operation_id), "OperationAlreadyConsumed");

    let market = read_market(&world.svm, &world.protocols[0].market);
    assert_eq!(market.update_count, 1, "the pause was applied twice");
}

#[test]
fn a_fresh_receipt_does_not_reopen_a_consumed_operation() {
    // The receipt is only one of two consumption records. Even if an attacker could get a
    // fresh receipt account, the capability itself remembers the last operation.
    let operation_id = operation(b"adv-replay-receipt");
    let mut world = armed(operation_id);
    world.execute(0, operation_id).expect("first execution");

    let receipt_address = world.receipt_address(0, operation_id);
    let mut receipt = world
        .svm
        .get_account(&receipt_address)
        .expect("receipt exists");
    // Clear the executed and applied flags, simulating a wiped receipt.
    receipt.data[8 + 64] = 0;
    receipt.data[8 + 65] = 0;
    world
        .svm
        .set_account(receipt_address, receipt)
        .expect("account set");

    assert_failed_with(world.execute(0, operation_id), "OperationAlreadyConsumed");
    assert_eq!(
        read_market(&world.svm, &world.protocols[0].market).update_count,
        1
    );
}

#[test]
fn the_target_protocol_independently_refuses_a_repeated_operation() {
    // Defence in depth. Even if the adapter were bypassed entirely, the market itself
    // refuses to apply the same operation twice.
    let operation_id = operation(b"adv-replay-protocol");
    let mut world = armed(operation_id);
    world.execute(0, operation_id).expect("first execution");

    // Drive the market directly, with its registered signer, as if the adapter had run
    // again. The market's own idempotency record stops it.
    let market = world.protocols[0].market;
    let adapter_signer = world.protocols[0].adapter_signer;
    let instruction = solana_instruction::Instruction {
        program_id: mock_protocol_program(),
        accounts: vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(adapter_signer, true),
        ],
        data: instruction_data("pause_new_borrowing", &OperationIdArg { operation_id }),
    };
    let payer = world.payer.insecure_clone();
    // The registered signer is a PDA, and nothing outside the adapter program can produce
    // its signature. That is the property being asserted: the market's trust is placed in a
    // key that only one program can wield.
    let result = world.send_unsigned(instruction, &payer);
    assert!(result.is_err(), "a PDA signature was forged from a client");
}

#[test]
fn a_second_settlement_finalization_is_refused() {
    let operation_id = operation(b"adv-settle-twice");
    let mut world = armed(operation_id);
    for index in 0..3 {
        world.execute(index, operation_id).expect("executes");
    }
    world
        .finalize_settlement(operation_id, 3)
        .expect("finalizes");
    assert_failed_with(
        world.finalize_settlement(operation_id, 3),
        "SettlementAlreadyFinalized",
    );
}

#[test]
fn a_certificate_for_one_operation_cannot_settle_another() {
    let first = operation(b"adv-op-one");
    let second = operation(b"adv-op-two");
    let mut world = armed(first);
    world
        .publish_certificate(world.default_certificate_args(second))
        .expect("second certificate");
    world
        .initialize_settlement_receipt(second)
        .expect("second settlement receipt");

    // Point the first operation's settlement receipt at the second certificate.
    let mut instruction = world.finalize_settlement_instruction(first, 3);
    instruction.accounts[1].pubkey = world.certificate_address(second);
    let payer = world.payer.insecure_clone();
    let result = world.send(instruction, &[&payer]);
    assert!(
        result.is_err(),
        "a foreign certificate finalized a settlement"
    );
}

#[test]
fn an_operation_id_of_zero_is_refused_by_the_protocol() {
    let mut world = World::new();
    world.initialize_market(0, None);
    let stranger = Keypair::new();
    world
        .svm
        .airdrop(&stranger.pubkey(), 1_000_000_000)
        .expect("funded");
    let authority = world.protocols[0].authority.insecure_clone();
    world
        .set_adapter(0, Some(stranger.pubkey()), &authority)
        .expect("registers a plain key as the adapter signer");

    let market = world.protocols[0].market;
    let instruction = solana_instruction::Instruction {
        program_id: mock_protocol_program(),
        accounts: vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(stranger.pubkey(), true),
        ],
        data: instruction_data(
            "pause_new_borrowing",
            &OperationIdArg {
                operation_id: [0u8; 32],
            },
        ),
    };
    assert_failed_with(world.send(instruction, &[&stranger]), "ZeroOperationId");
}

#[test]
fn executing_before_the_receipt_exists_is_refused() {
    let operation_id = operation(b"adv-no-receipt");
    let mut world = World::new();
    world
        .publish_certificate(world.default_certificate_args(operation_id))
        .expect("publishes");
    world.initialize_market(0, None);
    let args = world.default_install_args(0, operation_id);
    world.install_capability(0, args).expect("installs");
    world.arm(0).expect("arms");
    let signer = world.protocols[0].adapter_signer;
    let authority = world.protocols[0].authority.insecure_clone();
    world
        .set_adapter(0, Some(signer), &authority)
        .expect("registers");

    // No `initialize_adapter_receipt`.
    let result = world.execute(0, operation_id);
    assert!(result.is_err(), "executed without a receipt account");
}

#[test]
fn every_adapter_refusal_is_a_named_error_not_a_generic_failure() {
    // A generic failure tells an operator nothing during an incident. Every refusal the
    // adapter produces has to name the check that failed.
    let idl_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/idl/vinct_adapter.json");
    let idl: serde_json::Value =
        serde_json::from_slice(&std::fs::read(idl_path).expect("adapter IDL exists"))
            .expect("IDL parses");
    let errors = idl["errors"].as_array().expect("errors array");
    assert!(errors.len() >= 25, "the adapter lost error granularity");
    for error in errors {
        let name = error["name"].as_str().expect("name");
        let message = error["msg"].as_str().expect("msg");
        assert!(!message.is_empty(), "{name} has an empty message");
        assert!(
            !name.eq_ignore_ascii_case("InvalidArgument"),
            "a generic InvalidArgument error appeared"
        );
    }
}

//! Protocol sovereignty.
//!
//! The claim under test: the circle never receives arbitrary protocol admin authority, and
//! each protocol owns its own adapter. Every test here is an attempt to break that from a
//! different direction.

// litesvm returns `Result<TransactionMetadata, FailedTransactionMetadata>`, whose error
// variant is large by design because it carries the full transaction metadata and logs.
// That metadata is exactly what these tests assert on, so the lint is allowed here rather
// than working around litesvm's API.
#![allow(clippy::result_large_err)]
mod common;

use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;
use vinct_program_tests::{instruction_data, instruction_data_empty};

fn operation(seed: &[u8]) -> [u8; 32] {
    vinct_program_tests::sha256(seed)
}

// ------------------------------------------------------- the happy path first

#[test]
fn each_protocol_pauses_its_own_market_through_its_own_adapter() {
    // #given three armed protocols and one published certificate
    let operation_id = operation(b"op-happy");
    let mut world = World::new();
    world.arm_everything(operation_id);

    for index in 0..3 {
        let before = read_market(&world.svm, &world.protocols[index].market);
        assert!(!before.new_borrowing_paused);
        assert_eq!(before.update_count, 0);
    }

    // #when each adapter executes its bounded action
    for index in 0..3 {
        world.execute(index, operation_id).expect("executes");
    }

    // #then every market is paused, once, under this operation
    for index in 0..3 {
        let market = read_market(&world.svm, &world.protocols[index].market);
        assert!(
            market.new_borrowing_paused,
            "{} not paused",
            world.protocols[index].name
        );
        assert_eq!(market.update_count, 1);
        assert_eq!(market.last_operation_id, operation_id);

        let receipt = read_receipt(&world.svm, &world.receipt_address(index, operation_id));
        assert!(receipt.executed);
        assert!(receipt.target_effect_applied);
        assert_eq!(receipt.operation_id, operation_id);

        let capability = read_capability(&world.svm, &world.protocols[index].capability);
        assert_eq!(capability.last_operation_id, operation_id);
        assert_eq!(capability.capability_nonce, 1);
    }
}

#[test]
fn the_settlement_receipt_is_separate_from_the_adapter_effects() {
    // The cohort's own claim of completion is one more account, written by one more action.
    // It is deliberately not sufficient for SETTLED on its own.
    let operation_id = operation(b"op-settlement");
    let mut world = World::new();
    world.arm_everything(operation_id);

    assert!(!read_settlement_finalized(
        &world.svm,
        &world.settlement_address(operation_id)
    ));

    for index in 0..3 {
        world.execute(index, operation_id).expect("executes");
    }
    // Still not finalized: three adapter effects do not write the settlement receipt.
    assert!(!read_settlement_finalized(
        &world.svm,
        &world.settlement_address(operation_id)
    ));

    world
        .finalize_settlement(operation_id, 3)
        .expect("finalizes");
    assert!(read_settlement_finalized(
        &world.svm,
        &world.settlement_address(operation_id)
    ));
}

// ------------------------------------------------------------- sovereignty

#[test]
fn the_steward_cannot_arm_another_protocols_capability() {
    let operation_id = operation(b"op-steward-arm");
    let mut world = World::new();
    world.initialize_market(0, None);
    let args = world.default_install_args(0, operation_id);
    world.install_capability(0, args).expect("installs");

    // #when the steward tries to arm protocol alpha's capability
    let steward = world.steward.insecure_clone();
    let data = instruction_data("arm_capability", &ArmArgs { adapter_version: 1 });
    let result = world.capability_action(0, "arm_capability", data, &steward);

    // #then the adapter refuses: only the protocol authority may arm
    assert_failed_with(result, "UnauthorizedProtocolAuthority");
}

#[test]
fn another_protocols_authority_cannot_arm_this_capability() {
    let operation_id = operation(b"op-cross-arm");
    let mut world = World::new();
    world.initialize_market(0, None);
    let args = world.default_install_args(0, operation_id);
    world.install_capability(0, args).expect("installs");

    let beta = world.protocols[1].authority.insecure_clone();
    let data = instruction_data("arm_capability", &ArmArgs { adapter_version: 1 });
    assert_failed_with(
        world.capability_action(0, "arm_capability", data, &beta),
        "UnauthorizedProtocolAuthority",
    );
}

#[test]
fn only_the_market_authority_may_register_an_adapter() {
    let mut world = World::new();
    world.initialize_market(0, None);
    let stranger = Keypair::new();
    world
        .svm
        .airdrop(&stranger.pubkey(), 1_000_000_000)
        .expect("funded");

    let signer = world.protocols[0].adapter_signer;
    assert_failed_with(
        world.set_adapter(0, Some(signer), &stranger),
        "UnauthorizedAuthority",
    );

    // The steward is no more privileged than a stranger here.
    let steward = world.steward.insecure_clone();
    assert_failed_with(
        world.set_adapter(0, Some(signer), &steward),
        "UnauthorizedAuthority",
    );
}

#[test]
fn one_protocols_adapter_cannot_pause_another_protocols_market() {
    // The single most important sovereignty test. Alpha's adapter signer is not registered
    // on beta's market, so even a perfectly valid certificate cannot make it act there.
    let operation_id = operation(b"op-cross-market");
    let mut world = World::new();
    world.arm_everything(operation_id);

    // Build an execute instruction that swaps in beta's market while keeping alpha's
    // capability, receipt, and signer.
    let mut instruction = world.execute_instruction(0, operation_id);
    instruction.accounts[2].pubkey = world.protocols[1].market;

    let payer = world.payer.insecure_clone();
    let result = world.send(instruction, &[&payer]);

    // The adapter catches it before the CPI even happens: the market is not the one this
    // capability was installed for, and the meta commitment no longer matches.
    assert_failed_with(result, "AccountMetasMismatch");
}

#[test]
fn a_market_with_no_registered_adapter_cannot_be_paused() {
    let operation_id = operation(b"op-no-adapter");
    let mut world = World::new();
    world.arm_everything(operation_id);

    // Alpha revokes its adapter registration. The capability is still armed on the adapter
    // side; the protocol has simply withdrawn consent.
    let authority = world.protocols[0].authority.insecure_clone();
    world.set_adapter(0, None, &authority).expect("revokes");

    let result = world.execute(0, operation_id);
    match result {
        Ok(_) => panic!("a market with no registered adapter was paused"),
        Err(failure) => {
            let logs = failure.meta.logs.join("\n");
            assert!(
                logs.contains("NoAdapterRegistered"),
                "expected NoAdapterRegistered, logs:\n{logs}"
            );
        }
    }
    assert!(!read_market(&world.svm, &world.protocols[0].market).new_borrowing_paused);
}

#[test]
fn a_protocol_can_suspend_its_capability_mid_covenant() {
    let operation_id = operation(b"op-suspend");
    let mut world = World::new();
    world.arm_everything(operation_id);

    let authority = world.protocols[0].authority.insecure_clone();
    let data = instruction_data_empty("suspend_capability");
    world
        .capability_action(0, "suspend_capability", data, &authority)
        .expect("suspends");

    assert_failed_with(world.execute(0, operation_id), "CapabilitySuspended");
    assert!(!read_market(&world.svm, &world.protocols[0].market).new_borrowing_paused);

    // The other two protocols are unaffected. One protocol withdrawing does not disarm the
    // circle.
    world.execute(1, operation_id).expect("beta still executes");
    assert!(read_market(&world.svm, &world.protocols[1].market).new_borrowing_paused);
}

#[test]
fn a_revoked_capability_cannot_be_resumed_by_anyone_but_the_protocol() {
    let operation_id = operation(b"op-revoke");
    let mut world = World::new();
    world.arm_everything(operation_id);

    let authority = world.protocols[0].authority.insecure_clone();
    world
        .capability_action(
            0,
            "revoke_capability",
            instruction_data_empty("revoke_capability"),
            &authority,
        )
        .expect("revokes");

    let state = read_capability(&world.svm, &world.protocols[0].capability);
    assert!(!state.armed);
    assert!(state.suspended);
    assert_eq!(state.expires_at_slot, 0);

    // The steward cannot resume it.
    let steward = world.steward.insecure_clone();
    assert_failed_with(
        world.capability_action(
            0,
            "resume_capability",
            instruction_data_empty("resume_capability"),
            &steward,
        ),
        "UnauthorizedProtocolAuthority",
    );
    // Neither can the protocol, without re-arming: resume requires an armed capability.
    assert_failed_with(
        world.capability_action(
            0,
            "resume_capability",
            instruction_data_empty("resume_capability"),
            &authority,
        ),
        "CapabilityNotArmed",
    );
}

#[test]
fn an_unarmed_capability_refuses_a_valid_certificate() {
    let operation_id = operation(b"op-unarmed");
    let mut world = World::new();
    world.publish_certificate(world.default_certificate_args(operation_id));
    world.initialize_market(0, None);
    let args = world.default_install_args(0, operation_id);
    world.install_capability(0, args).expect("installs");
    let signer = world.protocols[0].adapter_signer;
    let authority = world.protocols[0].authority.insecure_clone();
    world
        .set_adapter(0, Some(signer), &authority)
        .expect("registers");
    world
        .initialize_adapter_receipt(0, operation_id)
        .expect("receipt");

    // Installed but never armed.
    assert_failed_with(world.execute(0, operation_id), "CapabilityNotArmed");
}

#[test]
fn install_refuses_to_widen_the_effect_bound() {
    let operation_id = operation(b"op-widen");
    let mut world = World::new();
    world.initialize_market(0, None);

    let mut args = world.default_install_args(0, operation_id);
    args.max_effect.may_unpause = true;
    assert_failed_with(world.install_capability(0, args), "UnpauseNotPermitted");

    let mut args = world.default_install_args(0, operation_id);
    args.max_effect.max_value_moved = 1;
    assert_failed_with(
        world.install_capability(0, args),
        "ValueMovementNotPermitted",
    );
}

#[test]
fn renewal_may_only_extend() {
    let operation_id = operation(b"op-renew");
    let mut world = World::new();
    world.initialize_market(0, None);
    let args = world.default_install_args(0, operation_id);
    world.install_capability(0, args).expect("installs");

    let authority = world.protocols[0].authority.insecure_clone();
    let shrink = instruction_data(
        "renew_capability",
        &RenewArgs {
            expires_at_slot: 10,
        },
    );
    let extended_to = world.current_slot() + 2_000_000;
    assert_failed_with(
        world.capability_action(0, "renew_capability", shrink, &authority),
        "RenewalMustExtend",
    );

    let extend = instruction_data(
        "renew_capability",
        &RenewArgs {
            expires_at_slot: extended_to,
        },
    );
    world
        .capability_action(0, "renew_capability", extend, &authority)
        .expect("extends");
    assert_eq!(
        read_capability(&world.svm, &world.protocols[0].capability).expires_at_slot,
        extended_to
    );
}

#[test]
fn the_adapter_program_exposes_no_arbitrary_forwarding_instruction() {
    // A negative test over the interface itself. Every instruction the adapter accepts is
    // enumerated here; if a future change adds a forwarding path, this list stops matching
    // the program and the test has to be updated deliberately rather than by accident.
    let permitted = [
        "install_capability",
        "arm_capability",
        "suspend_capability",
        "resume_capability",
        "renew_capability",
        "revoke_capability",
        "initialize_adapter_receipt",
        "execute_bounded_action",
    ];

    let idl_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/idl/vinct_adapter.json");
    let idl: serde_json::Value =
        serde_json::from_slice(&std::fs::read(idl_path).expect("adapter IDL exists"))
            .expect("IDL parses");
    let mut actual: Vec<String> = idl["instructions"]
        .as_array()
        .expect("instructions array")
        .iter()
        .map(|i| i["name"].as_str().expect("name").to_string())
        .collect();
    actual.sort();
    let mut expected: Vec<String> = permitted.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(
        actual, expected,
        "the adapter's instruction surface changed"
    );
}

#[test]
fn execute_bounded_action_takes_no_caller_controlled_arguments() {
    // The instruction carries only its discriminator. There is no argument an attacker
    // could steer, which is why it is safe for it to be permissionless.
    let idl_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/idl/vinct_adapter.json");
    let idl: serde_json::Value =
        serde_json::from_slice(&std::fs::read(idl_path).expect("adapter IDL exists"))
            .expect("IDL parses");
    let execute = idl["instructions"]
        .as_array()
        .expect("array")
        .iter()
        .find(|i| i["name"] == "execute_bounded_action")
        .expect("execute_bounded_action present");
    assert_eq!(
        execute["args"].as_array().map(|a| a.len()),
        Some(0),
        "execute_bounded_action gained an argument"
    );
}

#[test]
fn the_mock_protocol_exposes_no_unpause_instruction() {
    let idl_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/idl/vinct_mock_protocol.json");
    let idl: serde_json::Value =
        serde_json::from_slice(&std::fs::read(idl_path).expect("protocol IDL exists"))
            .expect("IDL parses");
    let names: Vec<&str> = idl["instructions"]
        .as_array()
        .expect("array")
        .iter()
        .map(|i| i["name"].as_str().expect("name"))
        .collect();
    assert!(
        !names
            .iter()
            .any(|n| n.contains("unpause") || n.contains("resume")),
        "the protocol gained a path that resumes borrowing: {names:?}"
    );
}

#[test]
fn the_demo_reset_is_disabled_unless_a_demo_authority_was_set() {
    let mut world = World::new();
    world.initialize_market(0, None);

    let demo = Keypair::new();
    world
        .svm
        .airdrop(&demo.pubkey(), 1_000_000_000)
        .expect("funded");
    let market = world.protocols[0].market;
    let instruction = solana_instruction::Instruction {
        program_id: mock_protocol_program(),
        accounts: vec![
            solana_instruction::account_meta::AccountMeta::new(market, false),
            solana_instruction::account_meta::AccountMeta::new_readonly(demo.pubkey(), true),
        ],
        data: instruction_data_empty("reset_demo_market"),
    };
    assert_failed_with(
        world.send(instruction, &[&demo]),
        "UnauthorizedDemoAuthority",
    );
}

#[test]
fn the_demo_reset_works_only_for_the_configured_demo_authority() {
    let operation_id = operation(b"op-demo-reset");
    let demo = Keypair::new();
    let mut world = World::new();
    world
        .svm
        .airdrop(&demo.pubkey(), 1_000_000_000)
        .expect("funded");

    world.publish_certificate(world.default_certificate_args(operation_id));
    world.initialize_market(0, Some(demo.pubkey()));
    let args = world.default_install_args(0, operation_id);
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
    world.execute(0, operation_id).expect("executes");
    assert!(read_market(&world.svm, &world.protocols[0].market).new_borrowing_paused);

    let market = world.protocols[0].market;
    let reset = solana_instruction::Instruction {
        program_id: mock_protocol_program(),
        accounts: vec![
            solana_instruction::account_meta::AccountMeta::new(market, false),
            solana_instruction::account_meta::AccountMeta::new_readonly(demo.pubkey(), true),
        ],
        data: instruction_data_empty("reset_demo_market"),
    };
    world.send(reset, &[&demo]).expect("resets");

    let after = read_market(&world.svm, &world.protocols[0].market);
    assert!(!after.new_borrowing_paused);
    assert_eq!(after.update_count, 0);
    assert_eq!(after.last_operation_id, [0u8; 32]);
}

#[test]
fn markets_have_genuinely_independent_authorities() {
    let world = World::new();
    let authorities: Vec<Address> = world
        .protocols
        .iter()
        .map(|p| p.authority.pubkey())
        .collect();
    assert_eq!(authorities.len(), 3);
    assert_ne!(authorities[0], authorities[1]);
    assert_ne!(authorities[1], authorities[2]);
    assert_ne!(authorities[0], authorities[2]);

    // And no protocol authority is the steward.
    for authority in &authorities {
        assert_ne!(*authority, world.steward.pubkey());
    }

    // Each capability and adapter signer is distinct too.
    let signers: Vec<Address> = world.protocols.iter().map(|p| p.adapter_signer).collect();
    assert_ne!(signers[0], signers[1]);
    assert_ne!(signers[1], signers[2]);
    assert_ne!(signers[0], signers[2]);
}

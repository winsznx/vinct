//! Emits canonical account-layout vectors from the programs' own Rust types.
//!
//! Every account VINCT reads off the chain has a hand-written TypeScript decoder, and a
//! hand-written decoder is a second implementation of a layout that keeps moving. When one
//! drifts it does not fail: it reads the wrong bytes and returns numbers that look like
//! numbers. That happened once, and a local run reported two approvals as fifty while still
//! printing PASS. See `docs/decision-log.md` D-0051.
//!
//! This binary is the fix. It constructs each account with distinctive values, serialises it
//! exactly as the program would, and writes the bytes alongside the values they encode. The
//! TypeScript parity test decodes those bytes and checks every field. A field added, moved,
//! resized, or reordered in Rust changes the vectors, and the test fails until the decoder is
//! brought back into line.
//!
//! It depends on the programs as libraries, and is the only crate that does. The vectors have
//! to come from the same structs the programs write, or they would be a second opinion about
//! the layout rather than a record of it.
//!
//!   cargo run -q -p vinct-layouts --bin gen-account-vectors

use std::fs;
use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, Discriminator};
use serde_json::{json, Map, Value};

/// A distinctive pubkey. Recognisable in a hex dump, and different per slot.
fn key(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

/// A distinctive 32-byte digest.
fn digest(seed: u8) -> [u8; 32] {
    [seed; 32]
}

/// Serialises an account the way Anchor does: discriminator, then Borsh.
fn encode<T: AccountSerialize + Discriminator>(account: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    account
        .try_serialize(&mut bytes)
        .expect("account serialises");
    bytes
}

/// One account's vector: its bytes, and the values those bytes are supposed to decode to.
fn vector<T: AccountSerialize + Discriminator>(name: &str, account: &T, fields: Value) -> Value {
    let bytes = encode(account);
    json!({
        "account": name,
        "discriminator": hex::encode(T::DISCRIMINATOR),
        "byte_length": bytes.len(),
        "bytes": hex::encode(&bytes),
        "fields": fields,
    })
}

fn main() {
    use vinct_adapter::{ActionCategory, AdapterReceipt, EffectLimit, SovereignCapability};
    use vinct_core::covenant::{Covenant, CovenantMember, CovenantStatus, MemberRole};
    use vinct_core::incident::{
        BallotState, Decision, IncidentClaim, IncidentCore, IncidentStatus, MemberAttestation,
        MAX_PRIVATE_CLAIM, MAX_PRIVATE_NOTES,
    };
    use vinct_core::{IncidentCertificate, SettlementOperation, SettlementReceipt};
    use vinct_mock_protocol::ProtocolMarket;

    let mut vectors: Vec<Value> = Vec::new();

    // ------------------------------------------------------------------ covenant

    let covenant = Covenant {
        version: 1,
        steward: key(0x11),
        covenant_id: 0x0102_0304_0506_0708,
        circle_epoch: 7,
        cluster_genesis_hash: digest(0x21),
        status: CovenantStatus::Armed,
        policy_id: digest(0x22),
        action_bundle_template_hash: digest(0x23),
        required_approvals: 2,
        maximum_rejections: 1,
        response_window_slots: 5_000,
        certificate_lifetime_slots: 100_000,
        member_count: 3,
        ratified_count: 3,
        armed_count: 3,
        adapter_count: 3,
        member_set_hash: digest(0x24),
        valid_from_slot: 900,
        expires_at_slot: 10_000_900,
        bump: 254,
    };
    vectors.push(vector(
        "Covenant",
        &covenant,
        json!({
            "version": 1,
            "steward": key(0x11).to_string(),
            "covenantId": covenant.covenant_id.to_string(),
            "circleEpoch": "7",
            "clusterGenesisHash": hex::encode(digest(0x21)),
            "status": 2,
            "policyId": hex::encode(digest(0x22)),
            "actionBundleTemplateHash": hex::encode(digest(0x23)),
            "requiredApprovals": 2,
            "maximumRejections": 1,
            "responseWindowSlots": "5000",
            "certificateLifetimeSlots": "100000",
            "memberCount": 3,
            "ratifiedCount": 3,
            "armedCount": 3,
            "adapterCount": 3,
            "memberSetHash": hex::encode(digest(0x24)),
            "validFromSlot": "900",
            "expiresAtSlot": "10000900",
        }),
    ));

    let member = CovenantMember {
        version: 1,
        covenant: key(0x31),
        protocol: key(0x32),
        role: MemberRole::Protocol,
        adapter_capability: key(0x33),
        adapter_version: 9,
        ratified: true,
        armed: true,
        bump: 253,
    };
    vectors.push(vector(
        "CovenantMember",
        &member,
        json!({
            "version": 1,
            "covenant": key(0x31).to_string(),
            "protocol": key(0x32).to_string(),
            "role": 0,
            "adapterCapability": key(0x33).to_string(),
            "adapterVersion": 9,
            "ratified": true,
            "armed": true,
        }),
    ));

    // ------------------------------------------------------------------ incident

    let core = IncidentCore {
        version: 1,
        covenant: key(0x41),
        circle_epoch: 7,
        incident_id: 42,
        opener: key(0x42),
        status: IncidentStatus::CertifiedPendingSettlement,
        policy_id: digest(0x43),
        member_set_hash: digest(0x44),
        cluster_genesis_hash: digest(0x45),
        required_approvals: 2,
        maximum_rejections: 1,
        opened_at_slot: 100,
        expires_at_slot: 600,
        response_window_slots: 500,
        action_bundle_template_hash: digest(0x46),
        claim_digest: digest(0x47),
        operation_id: digest(0x48),
        certified_at_slot: 550,
        certificate_lifetime_slots: 9_000,
        member_count: 3,
        approval_count_after_terminal: 2,
        rejection_count_after_terminal: 0,
        bump: 252,
    };
    vectors.push(vector(
        "IncidentCore",
        &core,
        json!({
            "version": 1,
            "covenant": key(0x41).to_string(),
            "circleEpoch": "7",
            "incidentId": "42",
            "opener": key(0x42).to_string(),
            "status": 2,
            "policyId": hex::encode(digest(0x43)),
            "memberSetHash": hex::encode(digest(0x44)),
            "clusterGenesisHash": hex::encode(digest(0x45)),
            "requiredApprovals": 2,
            "maximumRejections": 1,
            "openedAtSlot": "100",
            "expiresAtSlot": "600",
            "responseWindowSlots": "500",
            "actionBundleTemplateHash": hex::encode(digest(0x46)),
            "claimDigest": hex::encode(digest(0x47)),
            "operationId": hex::encode(digest(0x48)),
            "certifiedAtSlot": "550",
            "certificateLifetimeSlots": "9000",
            "memberCount": 3,
            "approvalCountAfterTerminal": 2,
            "rejectionCountAfterTerminal": 0,
        }),
    ));

    // The claim's protected region is left zero on purpose. These vectors are committed to
    // the repository, and a fixture carrying bytes that look like evidence is a fixture
    // somebody will one day mistake for evidence.
    let claim = IncidentClaim {
        version: 1,
        incident: key(0x51),
        opener: key(0x52),
        private_claim: [0u8; MAX_PRIVATE_CLAIM],
        private_claim_len: 0,
        private_notes: [0u8; MAX_PRIVATE_NOTES],
        private_notes_len: 0,
        private_observation_start: 0,
        private_observation_end: 0,
        private_fields_zeroized: true,
        bump: 251,
    };
    vectors.push(vector(
        "IncidentClaim",
        &claim,
        json!({
            "version": 1,
            "incident": key(0x51).to_string(),
            "opener": key(0x52).to_string(),
            "privateFieldsZeroized": true,
        }),
    ));

    let attestation = MemberAttestation {
        version: 1,
        incident: key(0x61),
        member: key(0x62),
        opener: key(0x63),
        state: BallotState::Scrubbed,
        decision: Decision::None,
        submission_nonce: 0,
        submitted_at_slot: 0,
        has_decision: false,
        private_fields_zeroized: true,
        bump: 250,
    };
    vectors.push(vector(
        "MemberAttestation",
        &attestation,
        json!({
            "version": 1,
            "incident": key(0x61).to_string(),
            "member": key(0x62).to_string(),
            "opener": key(0x63).to_string(),
            "state": 3,
            "privateFieldsZeroized": true,
        }),
    ));

    // --------------------------------------------------------------- settlement

    let certificate = IncidentCertificate {
        issuing_authority: key(0x71),
        cluster_genesis_hash: digest(0x72),
        covenant: key(0x73),
        circle_epoch: 7,
        incident_id: 42,
        policy_id: digest(0x74),
        member_set_hash: digest(0x75),
        action_bundle_hash: digest(0x76),
        operation_id: digest(0x77),
        certificate_nonce: 550,
        approval_count: 2,
        rejection_count: 0,
        certified_at_slot: 550,
        expires_at_slot: 9_550,
        bump: 249,
    };
    vectors.push(vector(
        "IncidentCertificate",
        &certificate,
        json!({
            "issuingAuthority": key(0x71).to_string(),
            "clusterGenesisHash": hex::encode(digest(0x72)),
            "covenant": key(0x73).to_string(),
            "circleEpoch": "7",
            "incidentId": "42",
            "policyId": hex::encode(digest(0x74)),
            "memberSetHash": hex::encode(digest(0x75)),
            "actionBundleHash": hex::encode(digest(0x76)),
            "operationId": hex::encode(digest(0x77)),
            "certificateNonce": "550",
            "approvalCount": 2,
            "rejectionCount": 0,
            "certifiedAtSlot": "550",
            "expiresAtSlot": "9550",
        }),
    ));

    let settlement = SettlementReceipt {
        operation_id: digest(0x81),
        certificate: key(0x82),
        finalized: true,
        observed_action_count: 4,
        finalized_at_slot: 600,
        bump: 248,
    };
    vectors.push(vector(
        "SettlementReceipt",
        &settlement,
        json!({
            "operationId": hex::encode(digest(0x81)),
            "certificate": key(0x82).to_string(),
            "finalized": true,
            "observedActionCount": 4,
            "finalizedAtSlot": "600",
        }),
    ));

    let operation = SettlementOperation {
        operation_id: digest(0x91),
        certificate: key(0x92),
        authority: key(0x93),
        expected_action_count: 4,
        scheduled: true,
        scheduled_at_slot: 500,
        attempt_count: 1,
        bump: 247,
    };
    vectors.push(vector(
        "SettlementOperation",
        &operation,
        json!({
            "operationId": hex::encode(digest(0x91)),
            "certificate": key(0x92).to_string(),
            "authority": key(0x93).to_string(),
            "expectedActionCount": 4,
            "scheduled": true,
            "scheduledAtSlot": "500",
            "attemptCount": 1,
        }),
    ));

    // ------------------------------------------------------------------ adapter

    let capability = SovereignCapability {
        protocol_authority: key(0xA1),
        protocol_state: key(0xA2),
        core_program: key(0xA3),
        adapter_version: 1,
        cluster_genesis_hash: digest(0xA4),
        covenant: key(0xA5),
        circle_epoch: 7,
        policy_id: digest(0xA6),
        member_set_hash: digest(0xA7),
        action_category: ActionCategory::PauseNewBorrowing,
        target_program: key(0xA8),
        instruction_discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        action_template_hash: digest(0xA9),
        instruction_data_hash: digest(0xAA),
        max_effect: EffectLimit {
            may_pause: true,
            may_unpause: false,
            max_value_moved: 0,
        },
        valid_from_slot: 100,
        expires_at_slot: 900_000,
        armed: true,
        suspended: false,
        capability_nonce: 3,
        last_operation_id: digest(0xAB),
        bump: 246,
        signer_bump: 245,
    };
    vectors.push(vector(
        "SovereignCapability",
        &capability,
        json!({
            "protocolAuthority": key(0xA1).to_string(),
            "protocolState": key(0xA2).to_string(),
            "coreProgram": key(0xA3).to_string(),
            "adapterVersion": 1,
            "clusterGenesisHash": hex::encode(digest(0xA4)),
            "covenant": key(0xA5).to_string(),
            "circleEpoch": "7",
            "policyId": hex::encode(digest(0xA6)),
            "memberSetHash": hex::encode(digest(0xA7)),
            "actionCategory": 0,
            "targetProgram": key(0xA8).to_string(),
            "instructionDiscriminator": "0102030405060708",
            "actionTemplateHash": hex::encode(digest(0xA9)),
            "instructionDataHash": hex::encode(digest(0xAA)),
            "maxEffect": { "mayPause": true, "mayUnpause": false, "maxValueMoved": "0" },
            "validFromSlot": "100",
            "expiresAtSlot": "900000",
            "armed": true,
            "suspended": false,
            "capabilityNonce": "3",
            "lastOperationId": hex::encode(digest(0xAB)),
        }),
    ));

    let receipt = AdapterReceipt {
        operation_id: digest(0xB1),
        capability: key(0xB2),
        executed: true,
        target_effect_applied: true,
        executed_at_slot: 610,
        bump: 244,
    };
    vectors.push(vector(
        "AdapterReceipt",
        &receipt,
        json!({
            "operationId": hex::encode(digest(0xB1)),
            "capability": key(0xB2).to_string(),
            "executed": true,
            "targetEffectApplied": true,
            "executedAtSlot": "610",
        }),
    ));

    // ------------------------------------------------------------ mock protocol

    let market = ProtocolMarket {
        authority: key(0xC1),
        market_id: 1,
        adapter_signer: key(0xC2),
        new_borrowing_paused: true,
        last_operation_id: digest(0xC3),
        update_count: 5,
        demo_authority: Pubkey::default(),
        bump: 243,
    };
    vectors.push(vector(
        "ProtocolMarket",
        &market,
        json!({
            "authority": key(0xC1).to_string(),
            "marketId": "1",
            "adapterSigner": key(0xC2).to_string(),
            "newBorrowingPaused": true,
            "lastOperationId": hex::encode(digest(0xC3)),
            "updateCount": "5",
        }),
    ));

    // ------------------------------------------------------------------- write

    let mut by_name = Map::new();
    for entry in &vectors {
        let name = entry["account"].as_str().expect("named").to_string();
        by_name.insert(name, entry.clone());
    }

    let document = json!({
        "note": "Generated from the programs' own Rust types by crates/vinct-layouts. Never edited by hand. Regenerate with `pnpm gen-account-vectors` whenever an account layout changes.",
        "why": "Every account VINCT reads has a hand-written TypeScript decoder, and a drifted decoder returns plausible numbers rather than an error. See docs/decision-log.md D-0051.",
        "accounts": Value::Object(by_name),
    });

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/test-vectors/account-layouts.json");
    fs::create_dir_all(path.parent().expect("has a parent")).expect("vector directory");
    fs::write(
        &path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&document).expect("json")
        ),
    )
    .expect("vectors written");
    println!(
        "wrote {} account layouts to {}",
        vectors.len(),
        path.display()
    );
}

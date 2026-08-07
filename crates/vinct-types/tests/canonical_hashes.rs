//! Canonical hash discipline.
//!
//! Every mutation PRD section 12.5 lists must either change the digest or fail to decode.
//! A mutation that does neither is a forgery surface: it would let an attacker present
//! different instruction bytes under a certificate that was signed for something else.

use vinct_types::action::*;
use vinct_types::address::Address;
use vinct_types::attestation::*;
use vinct_types::certificate::*;
use vinct_types::covenant::*;
use vinct_types::domains;
use vinct_types::error::VinctTypesError;
use vinct_types::hash::{domain, from_slice_exact, sha256, Digest32};
use vinct_types::incident::*;
use vinct_types::policy::*;
use vinct_types::zeroize::*;

/// A named mutation applied to a canonical struct before re-hashing it.
///
/// Aliased because the tables below would otherwise be an unreadable nest of boxed
/// closures, and because clippy is right that it is a complex type.
type Mutation<T> = (&'static str, Box<dyn Fn(&mut T)>);

const CLUSTER: Digest32 = [0x11; 32];
const OTHER_CLUSTER: Digest32 = [0x22; 32];

fn addr(seed: u8) -> Address {
    Address::from_seed(seed)
}

fn template(index: u16) -> ActionTemplateV1 {
    ActionTemplateV1::new(
        index,
        addr(0xAD),
        1,
        addr(0xA2),
        addr(0x4C),
        [1, 2, 3, 4, 5, 6, 7, 8],
        vec![
            TemplateAccountMetaV1::derived(AccountRoleV1::Certificate, false, false),
            TemplateAccountMetaV1::fixed(addr(0xA2), false, true),
            TemplateAccountMetaV1::fixed(addr(0xA3), false, true),
            TemplateAccountMetaV1::derived(AccountRoleV1::AdapterReceipt, false, true),
        ],
        vec![1, 2, 3],
        EffectLimitV1::PAUSE_ONLY,
    )
}

fn bundle_template() -> ActionBundleTemplateV1 {
    ActionBundleTemplateV1::new(vec![template(0), template(1)]).expect("well-formed")
}

fn resolved() -> ResolvedAddressesV1 {
    ResolvedAddressesV1 {
        adapter_receipts: vec![addr(0xA4), addr(0xB4)],
        settlement_receipt: Some(addr(0x5E)),
        certificate: Some(addr(0xCE)),
    }
}

fn base_bundle() -> ActionBundleV1 {
    resolve_bundle(
        &bundle_template(),
        CLUSTER,
        addr(0xC0),
        1,
        7,
        sha256(b"policy"),
        sha256(b"members"),
        900,
        sha256(b"operation"),
        &[7, 7],
        &resolved(),
    )
    .expect("resolves")
}

// ---------------------------------------------------------------- determinism

#[test]
fn domain_separators_are_distinct() {
    let labels = [
        domains::COVENANT_V1,
        domains::MEMBER_SET_V1,
        domains::MEMBER_V1,
        domains::POLICY_V1,
        domains::POLICY_SET_V1,
        domains::ADAPTER_SET_V1,
        domains::ACTION_TEMPLATE_V1,
        domains::ACTION_BUNDLE_V1,
        domains::OPERATION_V1,
        domains::CERTIFICATE_V1,
        domains::ATTESTATION_V1,
        domains::INCIDENT_CLAIM_V1,
        domains::RECOVERY_V1,
    ];
    let mut digests: Vec<Digest32> = labels.iter().map(|l| domain(l)).collect();
    digests.sort();
    let before = digests.len();
    digests.dedup();
    assert_eq!(before, digests.len(), "two domain separators collide");
}

#[test]
fn hashing_is_deterministic_across_repeated_calls() {
    let bundle = base_bundle();
    let first = bundle.hash().expect("hashes");
    for _ in 0..64 {
        assert_eq!(bundle.hash().expect("hashes"), first);
    }
}

#[test]
fn borsh_round_trips_every_canonical_struct() {
    let bundle = base_bundle();
    let bytes = borsh::to_vec(&bundle).expect("serializes");
    let decoded: ActionBundleV1 = from_slice_exact(&bytes).expect("decodes");
    assert_eq!(decoded, bundle);
    assert_eq!(
        decoded.hash().expect("hashes"),
        bundle.hash().expect("hashes")
    );
}

// ---------------------------------------------------------- bundle mutations

/// Applies a mutation and asserts the digest moved.
fn assert_digest_changes(name: &str, mutate: impl FnOnce(&mut ActionBundleV1)) {
    let original = base_bundle();
    let baseline = original.hash().expect("hashes");
    let mut mutated = original;
    mutate(&mut mutated);
    match mutated.hash() {
        Ok(digest) => assert_ne!(
            digest, baseline,
            "{name} did not change the action bundle hash"
        ),
        Err(_) => { /* rejected outright, which is also acceptable */ }
    }
}

#[test]
fn mutating_cluster_genesis_hash_changes_the_digest() {
    assert_digest_changes("cluster genesis hash", |b| {
        b.cluster_genesis_hash = OTHER_CLUSTER
    });
}

#[test]
fn mutating_circle_epoch_changes_the_digest() {
    assert_digest_changes("circle epoch", |b| b.circle_epoch += 1);
}

#[test]
fn mutating_incident_id_changes_the_digest() {
    assert_digest_changes("incident id", |b| b.incident_id += 1);
}

#[test]
fn mutating_policy_id_changes_the_digest() {
    assert_digest_changes("policy id", |b| b.policy_id = sha256(b"other policy"));
}

#[test]
fn mutating_member_set_hash_changes_the_digest() {
    assert_digest_changes("member set hash", |b| {
        b.member_set_hash = sha256(b"other members")
    });
}

#[test]
fn mutating_bundle_expiry_changes_the_digest() {
    assert_digest_changes("bundle expiry", |b| b.bundle_expiry_slot += 1);
}

#[test]
fn mutating_operation_id_changes_the_digest() {
    assert_digest_changes("operation id", |b| {
        b.operation_id = sha256(b"other operation")
    });
}

#[test]
fn mutating_adapter_version_changes_the_digest() {
    assert_digest_changes("adapter version", |b| b.actions[0].adapter_version += 1);
}

#[test]
fn mutating_capability_nonce_changes_the_digest() {
    assert_digest_changes("capability nonce", |b| b.actions[0].capability_nonce += 1);
}

#[test]
fn mutating_instruction_discriminator_changes_the_digest() {
    assert_digest_changes("discriminator", |b| {
        b.actions[0].instruction_discriminator[0] ^= 0xFF
    });
}

#[test]
fn mutating_one_instruction_data_byte_changes_the_digest() {
    assert_digest_changes("instruction data", |b| {
        b.actions[0].instruction_data[0] ^= 0x01
    });
}

#[test]
fn appending_an_instruction_data_byte_changes_the_digest() {
    assert_digest_changes("instruction data length", |b| {
        b.actions[0].instruction_data.push(0)
    });
}

#[test]
fn mutating_effect_limit_changes_the_digest() {
    assert_digest_changes("effect limit unpause", |b| {
        b.actions[0].effect_limit.may_unpause = true
    });
    assert_digest_changes("effect limit value", |b| {
        b.actions[0].effect_limit.max_value_moved = 1
    });
}

#[test]
fn mutating_target_program_changes_the_digest() {
    assert_digest_changes("target program", |b| {
        b.actions[0].target_program_id = addr(0xEE)
    });
}

#[test]
fn mutating_adapter_capability_changes_the_digest() {
    assert_digest_changes("adapter capability", |b| {
        b.actions[0].adapter_capability = addr(0xEE)
    });
}

// ------------------------------------------------- account meta order and flags

#[test]
fn swapping_two_account_metas_changes_the_digest() {
    assert_digest_changes("account meta order", |b| {
        b.actions[0].account_metas.swap(1, 2)
    });
}

#[test]
fn sorting_account_metas_changes_the_digest() {
    // The single most important property in this file. Solana instruction order is
    // semantic: sorting the metas rewrites which account the program writes to. Any code
    // path that normalises them must be visible as a different hash.
    let original = base_bundle();
    let baseline = original.hash().expect("hashes");
    let mut sorted = original;
    sorted.actions[0]
        .account_metas
        .sort_by_key(|meta| meta.pubkey);
    assert_ne!(
        sorted.hash().expect("hashes"),
        baseline,
        "sorting account metas left the action bundle hash unchanged"
    );
}

#[test]
fn mutating_an_account_key_changes_the_digest() {
    assert_digest_changes("account key", |b| {
        b.actions[0].account_metas[2].pubkey = addr(0xEE)
    });
}

#[test]
fn mutating_the_signer_flag_changes_the_digest() {
    assert_digest_changes("signer flag", |b| {
        b.actions[0].account_metas[2].is_signer = !b.actions[0].account_metas[2].is_signer
    });
}

#[test]
fn mutating_the_writable_flag_changes_the_digest() {
    assert_digest_changes("writable flag", |b| {
        b.actions[0].account_metas[2].is_writable = !b.actions[0].account_metas[2].is_writable
    });
}

#[test]
fn adding_an_account_meta_changes_the_digest() {
    assert_digest_changes("extra account meta", |b| {
        b.actions[0].account_metas.push(CanonicalAccountMetaV1 {
            pubkey: addr(0xFF),
            is_signer: false,
            is_writable: true,
        })
    });
}

// ---------------------------------------------------------- action order rules

#[test]
fn swapping_two_actions_is_rejected_because_indices_stop_being_sequential() {
    let mut bundle = base_bundle();
    bundle.actions.swap(0, 1);
    assert_eq!(
        bundle.hash().unwrap_err(),
        VinctTypesError::ActionIndexNotSequential
    );
}

#[test]
fn reindexing_after_a_swap_still_changes_the_digest() {
    // A determined attacker fixes the indices after reordering. The per-action content
    // moves with it, so the digest still has to differ.
    let original = base_bundle();
    let baseline = original.hash().expect("hashes");
    let mut mutated = original;
    mutated.actions.swap(0, 1);
    for (position, action) in mutated.actions.iter_mut().enumerate() {
        action.action_index = position as u16;
    }
    assert_ne!(mutated.hash().expect("hashes"), baseline);
}

#[test]
fn duplicate_action_index_is_rejected() {
    let mut bundle = base_bundle();
    bundle.actions[1].action_index = 0;
    assert_eq!(
        bundle.hash().unwrap_err(),
        VinctTypesError::DuplicateActionIndex
    );
}

#[test]
fn non_zero_based_action_indices_are_rejected() {
    let mut bundle = base_bundle();
    bundle.actions[0].action_index = 1;
    bundle.actions[1].action_index = 2;
    assert_eq!(
        bundle.hash().unwrap_err(),
        VinctTypesError::ActionIndexNotSequential
    );
}

#[test]
fn empty_bundle_is_rejected() {
    let mut bundle = base_bundle();
    bundle.actions.clear();
    assert_eq!(
        bundle.hash().unwrap_err(),
        VinctTypesError::EmptyActionBundle
    );
}

#[test]
fn oversized_bundle_is_rejected() {
    let mut actions = Vec::new();
    for index in 0..=(vinct_types::limits::MAX_ACTIONS as u16) {
        actions.push(template(index));
    }
    assert_eq!(
        ActionBundleTemplateV1::new(actions).unwrap_err(),
        VinctTypesError::TooManyActions
    );
}

// ------------------------------------------------------------- trailing bytes

#[test]
fn trailing_bytes_after_a_bundle_are_rejected() {
    let bundle = base_bundle();
    let mut bytes = borsh::to_vec(&bundle).expect("serializes");
    bytes.push(0x00);
    assert_eq!(
        from_slice_exact::<ActionBundleV1>(&bytes).unwrap_err(),
        VinctTypesError::TrailingBytes
    );
}

#[test]
fn trailing_bytes_after_a_certificate_are_rejected() {
    let certificate = base_certificate();
    let mut bytes = borsh::to_vec(&certificate).expect("serializes");
    bytes.extend_from_slice(&[0xAA, 0xBB]);
    assert_eq!(
        from_slice_exact::<CertificateV1>(&bytes).unwrap_err(),
        VinctTypesError::TrailingBytes
    );
}

#[test]
fn truncated_bytes_are_rejected() {
    let bundle = base_bundle();
    let bytes = borsh::to_vec(&bundle).expect("serializes");
    let truncated = &bytes[..bytes.len() - 1];
    assert_eq!(
        from_slice_exact::<ActionBundleV1>(truncated).unwrap_err(),
        VinctTypesError::DeserializationFailed
    );
}

// ------------------------------------------------------------- operation ids

fn base_operation_inputs() -> OperationInputsV1 {
    OperationInputsV1 {
        cluster_genesis_hash: CLUSTER,
        covenant: addr(0xC0),
        circle_epoch: 1,
        incident_id: 7,
        policy_id: sha256(b"policy"),
        member_set_hash: sha256(b"members"),
        action_bundle_template_hash: bundle_template().hash().expect("hashes"),
        certificate_nonce: 42,
    }
}

#[test]
fn operation_id_is_deterministic() {
    let inputs = base_operation_inputs();
    assert_eq!(operation_id(&inputs), operation_id(&inputs));
}

#[test]
fn every_operation_input_changes_the_operation_id() {
    let base = base_operation_inputs();
    let baseline = operation_id(&base);

    let mutations: Vec<Mutation<OperationInputsV1>> = vec![
        (
            "cluster",
            Box::new(|i: &mut OperationInputsV1| i.cluster_genesis_hash = OTHER_CLUSTER),
        ),
        (
            "covenant",
            Box::new(|i: &mut OperationInputsV1| i.covenant = addr(0xEE)),
        ),
        (
            "epoch",
            Box::new(|i: &mut OperationInputsV1| i.circle_epoch += 1),
        ),
        (
            "incident",
            Box::new(|i: &mut OperationInputsV1| i.incident_id += 1),
        ),
        (
            "policy",
            Box::new(|i: &mut OperationInputsV1| i.policy_id = sha256(b"other")),
        ),
        (
            "members",
            Box::new(|i: &mut OperationInputsV1| i.member_set_hash = sha256(b"other")),
        ),
        (
            "template",
            Box::new(|i: &mut OperationInputsV1| i.action_bundle_template_hash = sha256(b"other")),
        ),
        (
            "nonce",
            Box::new(|i: &mut OperationInputsV1| i.certificate_nonce += 1),
        ),
    ];

    for (name, mutate) in mutations {
        let mut mutated = base;
        mutate(&mut mutated);
        assert_ne!(
            operation_id(&mutated),
            baseline,
            "{name} did not change the operation id"
        );
    }
}

#[test]
fn cross_cluster_replay_produces_a_different_operation_id() {
    let devnet = base_operation_inputs();
    let mut localnet = devnet;
    localnet.cluster_genesis_hash = OTHER_CLUSTER;
    assert_ne!(operation_id(&devnet), operation_id(&localnet));
}

#[test]
fn cross_incident_replay_produces_a_different_operation_id() {
    let first = base_operation_inputs();
    let mut second = first;
    second.incident_id += 1;
    assert_ne!(operation_id(&first), operation_id(&second));
}

#[test]
fn operation_id_does_not_depend_on_the_concrete_bundle() {
    // The correction recorded as D-0012. The operation ID must be computable before the
    // concrete bundle exists, because receipt addresses are seeded by it and appear in
    // that bundle's account metas.
    let inputs = base_operation_inputs();
    let operation = operation_id(&inputs);
    let bundle = resolve_bundle(
        &bundle_template(),
        inputs.cluster_genesis_hash,
        inputs.covenant,
        inputs.circle_epoch,
        inputs.incident_id,
        inputs.policy_id,
        inputs.member_set_hash,
        900,
        operation,
        &[7, 7],
        &resolved(),
    )
    .expect("resolves");
    assert_eq!(bundle.operation_id, operation);
    assert_eq!(operation_id(&inputs), operation);
}

// -------------------------------------------------------------- member sets

#[test]
fn member_set_rejects_duplicates() {
    let member = MemberV1::new(addr(0xA1), MemberRole::Protocol, addr(0xA2), 1);
    assert_eq!(
        MemberSetV1::new(vec![member, member]).unwrap_err(),
        VinctTypesError::DuplicateMember
    );
}

#[test]
fn member_set_rejects_empty() {
    assert_eq!(
        MemberSetV1::new(vec![]).unwrap_err(),
        VinctTypesError::EmptyMemberSet
    );
}

#[test]
fn member_set_hash_is_order_independent_at_construction() {
    let a = MemberV1::new(addr(0xA1), MemberRole::Protocol, addr(0xA2), 1);
    let b = MemberV1::new(addr(0xB1), MemberRole::Protocol, addr(0xB2), 1);
    let forward = MemberSetV1::new(vec![a, b]).expect("valid");
    let reverse = MemberSetV1::new(vec![b, a]).expect("valid");
    assert_eq!(
        forward.hash().expect("hashes"),
        reverse.hash().expect("hashes")
    );
}

#[test]
fn out_of_order_member_set_is_rejected_on_validate_not_silently_sorted() {
    let a = MemberV1::new(addr(0xA1), MemberRole::Protocol, addr(0xA2), 1);
    let b = MemberV1::new(addr(0xB1), MemberRole::Protocol, addr(0xB2), 1);
    let tampered = MemberSetV1 {
        members: vec![b, a],
    };
    assert_eq!(
        tampered.validate().unwrap_err(),
        VinctTypesError::MemberSetNotCanonicallyOrdered
    );
}

#[test]
fn changing_a_member_adapter_version_changes_the_member_set_hash() {
    let baseline = MemberSetV1::new(vec![
        MemberV1::new(addr(0xA1), MemberRole::Protocol, addr(0xA2), 1),
        MemberV1::new(addr(0xB1), MemberRole::Protocol, addr(0xB2), 1),
    ])
    .expect("valid")
    .hash()
    .expect("hashes");

    let bumped = MemberSetV1::new(vec![
        MemberV1::new(addr(0xA1), MemberRole::Protocol, addr(0xA2), 2),
        MemberV1::new(addr(0xB1), MemberRole::Protocol, addr(0xB2), 1),
    ])
    .expect("valid")
    .hash()
    .expect("hashes");

    assert_ne!(baseline, bumped);
}

// ------------------------------------------------------------------ templates

#[test]
fn template_rejects_a_derived_slot_carrying_an_address() {
    let mut action = template(0);
    action.account_metas[0] = TemplateAccountMetaV1 {
        role: AccountRoleV1::Certificate,
        pubkey: addr(0xCE),
        is_signer: false,
        is_writable: false,
    };
    assert_eq!(
        action.validate().unwrap_err(),
        VinctTypesError::TemplateRoleAddressMismatch
    );
}

#[test]
fn template_rejects_a_fixed_slot_with_no_address() {
    let mut action = template(0);
    action.account_metas[1] = TemplateAccountMetaV1 {
        role: AccountRoleV1::Fixed,
        pubkey: Address::ZERO,
        is_signer: false,
        is_writable: true,
    };
    assert_eq!(
        action.validate().unwrap_err(),
        VinctTypesError::TemplateRoleAddressMismatch
    );
}

#[test]
fn resolution_rejects_a_missing_derived_address() {
    let incomplete = ResolvedAddressesV1 {
        adapter_receipts: vec![addr(0xA4)],
        settlement_receipt: Some(addr(0x5E)),
        certificate: Some(addr(0xCE)),
    };
    let outcome = resolve_bundle(
        &bundle_template(),
        CLUSTER,
        addr(0xC0),
        1,
        7,
        sha256(b"policy"),
        sha256(b"members"),
        900,
        sha256(b"operation"),
        &[7, 7],
        &incomplete,
    );
    assert_eq!(
        outcome.unwrap_err(),
        VinctTypesError::UnresolvedTemplateAddress
    );
}

#[test]
fn resolution_rejects_a_zero_resolved_address() {
    let zeroed = ResolvedAddressesV1 {
        adapter_receipts: vec![Address::ZERO, addr(0xB4)],
        settlement_receipt: Some(addr(0x5E)),
        certificate: Some(addr(0xCE)),
    };
    let outcome = resolve_bundle(
        &bundle_template(),
        CLUSTER,
        addr(0xC0),
        1,
        7,
        sha256(b"policy"),
        sha256(b"members"),
        900,
        sha256(b"operation"),
        &[7, 7],
        &zeroed,
    );
    assert_eq!(outcome.unwrap_err(), VinctTypesError::ZeroResolvedAddress);
}

#[test]
fn resolution_preserves_template_account_order_exactly() {
    let template = bundle_template();
    let bundle = base_bundle();
    for (action_index, action) in bundle.actions.iter().enumerate() {
        let source = &template.actions[action_index];
        assert_eq!(action.account_metas.len(), source.account_metas.len());
        for (meta_index, meta) in action.account_metas.iter().enumerate() {
            assert_eq!(meta.is_signer, source.account_metas[meta_index].is_signer);
            assert_eq!(
                meta.is_writable,
                source.account_metas[meta_index].is_writable
            );
        }
    }
}

// ---------------------------------------------------------------- certificates

fn base_certificate() -> CertificateV1 {
    CertificateV1::new(
        CLUSTER,
        addr(0xC0),
        1,
        7,
        sha256(b"policy"),
        sha256(b"members"),
        base_bundle().hash().expect("hashes"),
        sha256(b"operation"),
        42,
        2,
        0,
        500,
        1100,
    )
}

fn bounds() -> CapabilityBoundsV1 {
    CapabilityBoundsV1 {
        cluster_genesis_hash: CLUSTER,
        covenant: addr(0xC0),
        circle_epoch: 1,
        policy_id: sha256(b"policy"),
        member_set_hash: sha256(b"members"),
        adapter_version: 1,
        armed: true,
        suspended: false,
        capability_nonce: 7,
        last_operation_id: [0u8; 32],
    }
}

#[test]
fn a_well_formed_certificate_passes_capability_validation() {
    let certificate = base_certificate();
    let expected = certificate.action_bundle_hash;
    assert_eq!(
        validate_certificate(&certificate, &bounds(), &expected, 7, 600),
        Ok(())
    );
}

/// One refusal case: name, capability bounds, expected bundle hash, nonce, slot, refusal.
type RefusalCase = (
    &'static str,
    CapabilityBoundsV1,
    Digest32,
    u64,
    u64,
    CertificateRefusal,
);

#[test]
fn certificate_validation_rejects_every_binding_mismatch() {
    let certificate = base_certificate();
    let expected = certificate.action_bundle_hash;

    let cases: Vec<RefusalCase> = vec![
        (
            "cluster",
            CapabilityBoundsV1 {
                cluster_genesis_hash: OTHER_CLUSTER,
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::ClusterMismatch,
        ),
        (
            "covenant",
            CapabilityBoundsV1 {
                covenant: addr(0xEE),
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::CovenantMismatch,
        ),
        (
            "epoch",
            CapabilityBoundsV1 {
                circle_epoch: 2,
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::EpochMismatch,
        ),
        (
            "policy",
            CapabilityBoundsV1 {
                policy_id: sha256(b"other"),
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::PolicyMismatch,
        ),
        (
            "member set",
            CapabilityBoundsV1 {
                member_set_hash: sha256(b"other"),
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::MemberSetMismatch,
        ),
        (
            "expiry",
            bounds(),
            expected,
            7,
            1100,
            CertificateRefusal::Expired,
        ),
        (
            "bundle",
            bounds(),
            sha256(b"other bundle"),
            7,
            600,
            CertificateRefusal::ActionBundleMismatch,
        ),
        (
            "unarmed",
            CapabilityBoundsV1 {
                armed: false,
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::CapabilityNotArmed,
        ),
        (
            "suspended",
            CapabilityBoundsV1 {
                suspended: true,
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::CapabilitySuspended,
        ),
        (
            "nonce",
            bounds(),
            expected,
            8,
            600,
            CertificateRefusal::CapabilityNonceMismatch,
        ),
        (
            "already consumed",
            CapabilityBoundsV1 {
                last_operation_id: sha256(b"operation"),
                ..bounds()
            },
            expected,
            7,
            600,
            CertificateRefusal::OperationAlreadyConsumed,
        ),
    ];

    for (name, capability, bundle_hash, nonce, slot, expected_refusal) in cases {
        assert_eq!(
            validate_certificate(&certificate, &capability, &bundle_hash, nonce, slot),
            Err(expected_refusal),
            "{name} was not refused as expected"
        );
    }
}

#[test]
fn a_prior_incidents_certificate_cannot_satisfy_a_new_one() {
    let first = base_certificate();
    let mut second = base_certificate();
    second.incident_id = 8;
    second.operation_id = sha256(b"second operation");
    assert_ne!(
        first.hash().expect("hashes"),
        second.hash().expect("hashes")
    );
    // Replaying the first operation against a capability that already consumed it fails.
    let consumed = CapabilityBoundsV1 {
        last_operation_id: first.operation_id,
        ..bounds()
    };
    assert_eq!(
        validate_certificate(&first, &consumed, &first.action_bundle_hash, 7, 600),
        Err(CertificateRefusal::OperationAlreadyConsumed)
    );
}

#[test]
fn every_certificate_field_changes_the_certificate_hash() {
    let baseline = base_certificate().hash().expect("hashes");
    let mutations: Vec<Mutation<CertificateV1>> = vec![
        (
            "cluster",
            Box::new(|c: &mut CertificateV1| c.cluster_genesis_hash = OTHER_CLUSTER),
        ),
        (
            "covenant",
            Box::new(|c: &mut CertificateV1| c.covenant = addr(0xEE)),
        ),
        (
            "epoch",
            Box::new(|c: &mut CertificateV1| c.circle_epoch += 1),
        ),
        (
            "incident",
            Box::new(|c: &mut CertificateV1| c.incident_id += 1),
        ),
        (
            "policy",
            Box::new(|c: &mut CertificateV1| c.policy_id = sha256(b"other")),
        ),
        (
            "members",
            Box::new(|c: &mut CertificateV1| c.member_set_hash = sha256(b"other")),
        ),
        (
            "bundle",
            Box::new(|c: &mut CertificateV1| c.action_bundle_hash = sha256(b"other")),
        ),
        (
            "operation",
            Box::new(|c: &mut CertificateV1| c.operation_id = sha256(b"other")),
        ),
        (
            "nonce",
            Box::new(|c: &mut CertificateV1| c.certificate_nonce += 1),
        ),
        (
            "approvals",
            Box::new(|c: &mut CertificateV1| c.approval_count += 1),
        ),
        (
            "rejections",
            Box::new(|c: &mut CertificateV1| c.rejection_count += 1),
        ),
        (
            "certified at",
            Box::new(|c: &mut CertificateV1| c.certified_at_slot += 1),
        ),
        (
            "expires at",
            Box::new(|c: &mut CertificateV1| c.expires_at_slot += 1),
        ),
    ];
    for (name, mutate) in mutations {
        let mut certificate = base_certificate();
        mutate(&mut certificate);
        assert_ne!(
            certificate.hash().expect("hashes"),
            baseline,
            "{name} did not change the certificate hash"
        );
    }
}

// ------------------------------------------------------------------- policies

#[test]
fn policy_rejects_a_zero_threshold() {
    let mut policy = base_policy();
    policy.required_approvals = 0;
    assert_eq!(
        policy.validate(3).unwrap_err(),
        VinctTypesError::ZeroRequiredApprovals
    );
}

#[test]
fn policy_rejects_a_threshold_above_the_member_count() {
    let policy = base_policy();
    assert_eq!(
        policy.validate(1).unwrap_err(),
        VinctTypesError::ThresholdExceedsMemberCount
    );
}

#[test]
fn policy_rejects_zero_windows() {
    let mut policy = base_policy();
    policy.response_window_slots = 0;
    assert_eq!(
        policy.validate(3).unwrap_err(),
        VinctTypesError::ZeroResponseWindow
    );

    let mut policy = base_policy();
    policy.certificate_ttl_slots = 0;
    assert_eq!(
        policy.validate(3).unwrap_err(),
        VinctTypesError::ZeroCertificateLifetime
    );
}

fn base_policy() -> ResponsePolicyV1 {
    ResponsePolicyV1::new(
        sha256(b"policy"),
        ActionCategory::PauseNewBorrowing,
        DependencyNamespace::PriceFeed,
        sha256(b"dependency"),
        sha256(b"members"),
        2,
        1,
        vec![MemberRole::Protocol],
        300,
        600,
        bundle_template().hash().expect("hashes"),
    )
}

#[test]
fn policy_set_hash_is_independent_of_drafting_order() {
    let mut first = base_policy();
    first.policy_id = sha256(b"policy-1");
    let mut second = base_policy();
    second.policy_id = sha256(b"policy-2");

    let forward = policies_hash(&[first.clone(), second.clone()]).expect("hashes");
    let reverse = policies_hash(&[second, first]).expect("hashes");
    assert_eq!(forward, reverse);
}

// ---------------------------------------------------------------- zeroization

#[test]
fn zeroizable_bytes_keep_their_length_and_lose_their_content() {
    let mut buffer = ZeroizableBytes::new(b"private incident evidence".to_vec()).expect("bounded");
    let length = buffer.len();
    assert!(!buffer.is_zeroized());
    buffer.zeroize();
    assert!(buffer.is_zeroized());
    assert_eq!(
        buffer.len(),
        length,
        "zeroization must not reveal payload size by shrinking"
    );
}

#[test]
fn oversized_private_payload_is_rejected() {
    let oversized = vec![0u8; vinct_types::limits::MAX_PRIVATE_PAYLOAD + 1];
    assert_eq!(
        ZeroizableBytes::new(oversized).unwrap_err(),
        VinctTypesError::PrivatePayloadTooLong
    );
}

#[test]
fn commit_is_refused_for_every_unscrubbed_field() {
    assert_eq!(
        ZeroizationState::DIRTY.may_commit(),
        Err(ZeroizationRefusal::ClaimNotZeroized)
    );
    assert_eq!(
        ZeroizationState {
            claim_zeroized: true,
            ..ZeroizationState::DIRTY
        }
        .may_commit(),
        Err(ZeroizationRefusal::AttestationsRemain)
    );
    assert_eq!(
        ZeroizationState {
            claim_zeroized: true,
            attestations_cleared: true,
            ..ZeroizationState::DIRTY
        }
        .may_commit(),
        Err(ZeroizationRefusal::ObservationWindowNotZeroized)
    );
    assert_eq!(
        ZeroizationState {
            claim_zeroized: true,
            attestations_cleared: true,
            observation_window_zeroized: true,
            ..ZeroizationState::DIRTY
        }
        .may_commit(),
        Err(ZeroizationRefusal::NotesNotZeroized)
    );
    assert_eq!(
        ZeroizationState {
            flag: false,
            ..ZeroizationState::CLEAN
        }
        .may_commit(),
        Err(ZeroizationRefusal::FlagNotSet)
    );
    assert_eq!(ZeroizationState::CLEAN.may_commit(), Ok(()));
}

#[test]
fn setting_the_flag_without_scrubbing_still_refuses_commit() {
    // The flag is a claim; the byte checks are the evidence. A program that sets the flag
    // first must still be stopped.
    let lying = ZeroizationState {
        flag: true,
        ..ZeroizationState::DIRTY
    };
    assert_eq!(
        lying.may_commit(),
        Err(ZeroizationRefusal::ClaimNotZeroized)
    );
}

// ------------------------------------------------------------------ claims

#[test]
fn incident_claim_digest_changes_with_every_field() {
    let base = IncidentClaimV1::new(
        DependencyNamespace::PriceFeed,
        sha256(b"dependency"),
        1_700_000_000,
        1_700_003_600,
        sha256(b"schema"),
        sha256(b"evidence"),
        SignalCategory::OracleDeviation,
        ConfidenceBucket::High,
        ActionCategory::PauseNewBorrowing,
        addr(0xA1),
        1,
    );
    let baseline = base.digest().expect("hashes");

    let mutations: Vec<Mutation<IncidentClaimV1>> = vec![
        (
            "namespace",
            Box::new(|c: &mut IncidentClaimV1| {
                c.dependency_namespace = DependencyNamespace::Bridge
            }),
        ),
        (
            "dependency",
            Box::new(|c: &mut IncidentClaimV1| c.dependency_id = sha256(b"other")),
        ),
        (
            "window start",
            Box::new(|c: &mut IncidentClaimV1| c.observation_window_start += 1),
        ),
        (
            "window end",
            Box::new(|c: &mut IncidentClaimV1| c.observation_window_end += 1),
        ),
        (
            "schema",
            Box::new(|c: &mut IncidentClaimV1| c.claim_schema_hash = sha256(b"other")),
        ),
        (
            "evidence",
            Box::new(|c: &mut IncidentClaimV1| c.private_evidence_digest = sha256(b"other")),
        ),
        (
            "signal",
            Box::new(|c: &mut IncidentClaimV1| {
                c.signal_category = SignalCategory::UnexplainedOutflow
            }),
        ),
        (
            "confidence",
            Box::new(|c: &mut IncidentClaimV1| c.confidence_bucket = ConfidenceBucket::Low),
        ),
        (
            "submitter",
            Box::new(|c: &mut IncidentClaimV1| c.submitter = addr(0xEE)),
        ),
        (
            "nonce",
            Box::new(|c: &mut IncidentClaimV1| c.submission_nonce += 1),
        ),
    ];
    for (name, mutate) in mutations {
        let mut claim = base;
        mutate(&mut claim);
        assert_ne!(
            claim.digest().expect("hashes"),
            baseline,
            "{name} did not change the claim digest"
        );
    }
}

#[test]
fn an_inverted_observation_window_is_rejected() {
    let mut claim = IncidentClaimV1::new(
        DependencyNamespace::PriceFeed,
        sha256(b"dependency"),
        1_700_003_600,
        1_700_000_000,
        sha256(b"schema"),
        sha256(b"evidence"),
        SignalCategory::OracleDeviation,
        ConfidenceBucket::High,
        ActionCategory::PauseNewBorrowing,
        addr(0xA1),
        1,
    );
    assert!(!claim.window_is_valid());
    claim.observation_window_end = claim.observation_window_start + 1;
    assert!(claim.window_is_valid());
}

// ------------------------------------------------------------- attestations

#[test]
fn attestation_digest_changes_with_the_decision() {
    let approve = AttestationV1::new(addr(0xC0), 1, 7, addr(0xA1), Decision::Approve, 1, 100);
    let mut reject = approve;
    reject.decision = Decision::Reject;
    assert_ne!(
        approve.digest().expect("hashes"),
        reject.digest().expect("hashes")
    );
}

#[test]
fn attestation_binding_rejects_another_incident() {
    let attestation = AttestationV1::new(addr(0xC0), 1, 7, addr(0xA1), Decision::Approve, 1, 100);
    assert!(attestation.matches_incident(&addr(0xC0), 1, 7));
    assert!(
        !attestation.matches_incident(&addr(0xC0), 1, 8),
        "cross-incident replay accepted"
    );
    assert!(
        !attestation.matches_incident(&addr(0xC0), 2, 7),
        "stale-epoch replay accepted"
    );
    assert!(
        !attestation.matches_incident(&addr(0xEE), 1, 7),
        "cross-covenant replay accepted"
    );
}

// ------------------------------------------------------------ incident status

#[test]
fn only_the_expected_statuses_are_terminal() {
    use IncidentStatus::*;
    for status in [Settled, Expired, Aborted, CommitWithoutActions] {
        assert!(status.is_terminal(), "{status:?} should be terminal");
    }
    for status in [
        Draft,
        Open,
        Collecting,
        CertifiedPendingSettlement,
        Settling,
        ReconciliationRequired,
        SettlementUnknown,
    ] {
        assert!(!status.is_terminal(), "{status:?} should not be terminal");
    }
}

#[test]
fn only_open_and_collecting_accept_attestations() {
    use IncidentStatus::*;
    assert!(Open.accepts_attestations());
    assert!(Collecting.accepts_attestations());
    for status in [
        Draft,
        CertifiedPendingSettlement,
        Settling,
        Settled,
        CommitWithoutActions,
        ReconciliationRequired,
        SettlementUnknown,
        Expired,
        Aborted,
    ] {
        assert!(
            !status.accepts_attestations(),
            "{status:?} must not accept attestations"
        );
    }
}

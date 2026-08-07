//! Regression suite for the operation-ID correction recorded as D-0012.
//!
//! PRD section 12.4 derived the operation ID from the concrete action-bundle hash while
//! PRD section 12.3 placed the operation ID inside that same bundle. Receipt PDAs are
//! seeded by the operation ID and appear in the bundle's account metas, which closes the
//! loop a second time. Neither value could be computed first.
//!
//! The correction derives the operation ID from the policy's registered *template* hash,
//! which is operation-independent. These tests prove the correction kept every binding
//! the PRD's security invariants require, and that the concrete bundle is still bound
//! cryptographically through the certificate.

use vinct_reference::certify;
use vinct_reference::evaluate::*;
use vinct_reference::fixtures::*;
use vinct_reference::model::*;
use vinct_types::action::*;
use vinct_types::attestation::{AttestationV1, Decision};
use vinct_types::certificate::*;
use vinct_types::hash::{sha256, Digest32};
use vinct_types::zeroize::ZeroizationState;
use vinct_types::Address;

/// A named mutation applied to the operation inputs.
type Mutation = (&'static str, Box<dyn Fn(&mut OperationInputsV1)>);

const OPENED: u64 = 1_000;
const NOW: u64 = 1_100;

/// A certified fixture incident, ready to produce a certificate.
fn certified() -> (CovenantSnapshot, IncidentState) {
    let covenant = covenant_snapshot();
    let mut incident = incident_state(7, OPENED);
    for member in [PROTOCOL_A, PROTOCOL_B] {
        let attestation = AttestationV1::new(COVENANT, 1, 7, member, Decision::Approve, 1, NOW);
        submit_attestation(&covenant, &mut incident, attestation, NOW).expect("accepted");
    }
    assert_eq!(
        evaluate_incident(&covenant, &incident, NOW)
            .expect("evaluates")
            .outcome,
        EvaluationOutcome::Certified
    );
    (covenant, incident)
}

fn issue(
    covenant: &CovenantSnapshot,
    incident: &IncidentState,
) -> vinct_reference::CertifiedOperation {
    certify(
        covenant,
        incident,
        ZeroizationState::CLEAN,
        CERTIFICATE_NONCE,
        &CAPABILITY_NONCES,
        &resolved_addresses(),
        NOW,
    )
    .expect("certifies")
}

fn operation_inputs_for(incident: &IncidentState, nonce: u64) -> OperationInputsV1 {
    OperationInputsV1 {
        cluster_genesis_hash: incident.snapshot.cluster_genesis_hash,
        covenant: incident.snapshot.covenant,
        circle_epoch: incident.snapshot.circle_epoch,
        incident_id: incident.snapshot.incident_id,
        policy_id: incident.snapshot.policy_id,
        member_set_hash: incident.snapshot.member_set_hash,
        action_bundle_template_hash: incident.snapshot.action_bundle_template_hash,
        certificate_nonce: nonce,
    }
}

// ------------------------------------------------------- no circular derivation

#[test]
fn the_operation_id_is_computable_before_any_concrete_bundle_exists() {
    // The whole point of the correction. Every input is known at incident-open time plus
    // the nonce drawn at certification. Nothing here needs a resolved receipt address, a
    // concrete account meta, or a bundle hash.
    let (_, incident) = certified();
    let inputs = operation_inputs_for(&incident, CERTIFICATE_NONCE);
    let operation = operation_id(&inputs);
    assert_ne!(operation, [0u8; 32]);

    // Only now can the receipt addresses be derived and the concrete bundle assembled.
    let issued = issue(&covenant_snapshot(), &incident);
    assert_eq!(issued.operation_id, operation);
    assert_eq!(issued.bundle.operation_id, operation);
}

#[test]
fn resolving_the_bundle_consumes_the_operation_id_and_never_produces_it() {
    let (covenant, incident) = certified();
    let inputs = operation_inputs_for(&incident, CERTIFICATE_NONCE);
    let operation = operation_id(&inputs);

    let bundle = resolve_bundle(
        &covenant.template,
        incident.snapshot.cluster_genesis_hash,
        incident.snapshot.covenant,
        incident.snapshot.circle_epoch,
        incident.snapshot.incident_id,
        incident.snapshot.policy_id,
        incident.snapshot.member_set_hash,
        NOW + covenant.policy.certificate_ttl_slots,
        operation,
        &CAPABILITY_NONCES,
        &resolved_addresses(),
    )
    .expect("resolves");

    // The bundle hash depends on the operation ID, and the operation ID does not depend
    // on the bundle hash. That is the acyclic direction.
    let bundle_hash = bundle.hash().expect("hashes");
    assert_ne!(bundle_hash, operation);
    assert_eq!(
        operation_id(&inputs),
        operation,
        "operation id moved after bundle resolution"
    );
}

#[test]
fn a_receipt_address_change_moves_the_bundle_hash_but_not_the_operation_id() {
    // Receipt PDAs are seeded by the operation ID, so they belong downstream of it. This
    // asserts the dependency runs one way only.
    let (covenant, incident) = certified();
    let inputs = operation_inputs_for(&incident, CERTIFICATE_NONCE);
    let operation = operation_id(&inputs);

    let build = |resolved: &ResolvedAddressesV1| {
        resolve_bundle(
            &covenant.template,
            incident.snapshot.cluster_genesis_hash,
            incident.snapshot.covenant,
            incident.snapshot.circle_epoch,
            incident.snapshot.incident_id,
            incident.snapshot.policy_id,
            incident.snapshot.member_set_hash,
            NOW + covenant.policy.certificate_ttl_slots,
            operation,
            &CAPABILITY_NONCES,
            resolved,
        )
        .expect("resolves")
        .hash()
        .expect("hashes")
    };

    let baseline = build(&resolved_addresses());
    let mut moved = resolved_addresses();
    moved.adapter_receipts[0] = Address::from_seed(0xEE);
    assert_ne!(
        build(&moved),
        baseline,
        "a substituted receipt left the bundle hash unchanged"
    );
    assert_eq!(
        operation_id(&inputs),
        operation,
        "a receipt change moved the operation id"
    );
}

// ------------------------------------------------------------------ determinism

#[test]
fn the_operation_id_is_deterministic_across_repeated_certifications() {
    let (covenant, incident) = certified();
    let first = issue(&covenant, &incident);
    for _ in 0..32 {
        let again = issue(&covenant, &incident);
        assert_eq!(again.operation_id, first.operation_id);
        assert_eq!(again.action_bundle_hash, first.action_bundle_hash);
        assert_eq!(again.certificate_hash, first.certificate_hash);
    }
}

// --------------------------------------------------------- binding preserved

#[test]
fn the_operation_id_is_bound_to_the_cluster() {
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);
    let mut other_cluster = base;
    other_cluster.cluster_genesis_hash = OTHER_CLUSTER;
    assert_ne!(operation_id(&other_cluster), operation_id(&base));
}

#[test]
fn the_operation_id_is_bound_to_the_covenant_and_epoch() {
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);

    let mut other_covenant = base;
    other_covenant.covenant = Address::from_seed(0xEE);
    assert_ne!(operation_id(&other_covenant), operation_id(&base));

    let mut other_epoch = base;
    other_epoch.circle_epoch += 1;
    assert_ne!(operation_id(&other_epoch), operation_id(&base));
}

#[test]
fn the_operation_id_is_bound_to_the_incident() {
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);
    let mut other_incident = base;
    other_incident.incident_id += 1;
    assert_ne!(operation_id(&other_incident), operation_id(&base));
}

#[test]
fn the_operation_id_is_bound_to_the_policy_and_member_set() {
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);

    let mut other_policy = base;
    other_policy.policy_id = sha256(b"a different policy");
    assert_ne!(operation_id(&other_policy), operation_id(&base));

    let mut other_members = base;
    other_members.member_set_hash = sha256(b"a different member set");
    assert_ne!(operation_id(&other_members), operation_id(&base));
}

#[test]
fn changing_the_registered_template_changes_the_operation_id() {
    // The replacement for the PRD's bundle-hash input. A protocol that re-arms its adapter
    // with different bounds produces a different template hash, so every operation issued
    // afterwards has a different identity.
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);

    let shortened = ActionBundleTemplateV1::new(vec![
        adapter_template(0, CAPABILITY_A, MARKET_A),
        adapter_template(1, CAPABILITY_B, MARKET_B),
    ])
    .expect("valid");

    let mut other_template = base;
    other_template.action_bundle_template_hash = shortened.hash().expect("hashes");
    assert_ne!(operation_id(&other_template), operation_id(&base));
}

#[test]
fn a_one_byte_template_change_changes_the_operation_id() {
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);

    let mut tampered = bundle_template();
    tampered.actions[0].instruction_data[0] ^= 0x01;

    let mut mutated = base;
    mutated.action_bundle_template_hash = tampered.hash().expect("hashes");
    assert_ne!(operation_id(&mutated), operation_id(&base));
}

#[test]
fn the_operation_id_is_bound_to_the_certificate_nonce() {
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);
    let mut other_nonce = base;
    other_nonce.certificate_nonce += 1;
    assert_ne!(operation_id(&other_nonce), operation_id(&base));
}

// ------------------------------------------ concrete bundle bound via certificate

#[test]
fn the_certificate_carries_the_concrete_bundle_hash() {
    let (covenant, incident) = certified();
    let issued = issue(&covenant, &incident);
    assert_eq!(
        issued.certificate.action_bundle_hash,
        issued.bundle.hash().expect("hashes")
    );
    assert_eq!(issued.certificate.operation_id, issued.operation_id);
}

#[test]
fn a_substituted_concrete_bundle_fails_certificate_validation() {
    // The binding the PRD wanted from putting the bundle hash inside the operation ID is
    // still enforced, one level up: the adapter compares the certificate's
    // `action_bundle_hash` against the bundle it was handed.
    let (covenant, incident) = certified();
    let issued = issue(&covenant, &incident);

    let mut tampered = issued.bundle.clone();
    tampered.actions[0].account_metas.swap(1, 2);
    let tampered_hash = tampered.hash().expect("hashes");
    assert_ne!(tampered_hash, issued.action_bundle_hash);

    let bounds = CapabilityBoundsV1 {
        cluster_genesis_hash: FIXTURE_CLUSTER,
        covenant: COVENANT,
        circle_epoch: 1,
        policy_id: policy_id(),
        member_set_hash: covenant.member_set.hash().expect("hashes"),
        adapter_version: 1,
        armed: true,
        suspended: false,
        capability_nonce: CAPABILITY_NONCES[0],
        last_operation_id: [0u8; 32],
    };

    assert_eq!(
        validate_certificate(
            &issued.certificate,
            &bounds,
            &tampered_hash,
            CAPABILITY_NONCES[0],
            NOW
        ),
        Err(CertificateRefusal::ActionBundleMismatch)
    );
    assert_eq!(
        validate_certificate(
            &issued.certificate,
            &bounds,
            &issued.action_bundle_hash,
            CAPABILITY_NONCES[0],
            NOW
        ),
        Ok(())
    );
}

#[test]
fn changing_the_concrete_bundle_changes_the_certificate_hash() {
    // Two incidents that differ only in a resolved receipt address produce different
    // bundle hashes and therefore different certificates.
    let (covenant, incident) = certified();
    let baseline = issue(&covenant, &incident);

    let mut moved = resolved_addresses();
    moved.adapter_receipts[1] = Address::from_seed(0xEE);
    let shifted = certify(
        &covenant,
        &incident,
        ZeroizationState::CLEAN,
        CERTIFICATE_NONCE,
        &CAPABILITY_NONCES,
        &moved,
        NOW,
    )
    .expect("certifies");

    assert_ne!(shifted.action_bundle_hash, baseline.action_bundle_hash);
    assert_ne!(shifted.certificate_hash, baseline.certificate_hash);
    // The operation identity is unchanged, because nothing upstream of it moved.
    assert_eq!(shifted.operation_id, baseline.operation_id);
}

// ------------------------------------------------------------------- replay

fn bounds_for(certificate: &vinct_types::certificate::CertificateV1) -> CapabilityBoundsV1 {
    CapabilityBoundsV1 {
        cluster_genesis_hash: certificate.cluster_genesis_hash,
        covenant: certificate.covenant,
        circle_epoch: certificate.circle_epoch,
        policy_id: certificate.policy_id,
        member_set_hash: certificate.member_set_hash,
        adapter_version: 1,
        armed: true,
        suspended: false,
        capability_nonce: CAPABILITY_NONCES[0],
        last_operation_id: [0u8; 32],
    }
}

fn certified_incident(incident_id: u64) -> (CovenantSnapshot, IncidentState) {
    let covenant = covenant_snapshot();
    let mut incident = incident_state(incident_id, OPENED);
    for member in [PROTOCOL_A, PROTOCOL_B] {
        let attestation =
            AttestationV1::new(COVENANT, 1, incident_id, member, Decision::Approve, 1, NOW);
        submit_attestation(&covenant, &mut incident, attestation, NOW).expect("accepted");
    }
    (covenant, incident)
}

#[test]
fn replay_across_incidents_fails() {
    let (covenant_a, incident_a) = certified_incident(7);
    let (_, incident_b) = certified_incident(8);
    let first = issue(&covenant_a, &incident_a);
    let second = issue(&covenant_a, &incident_b);

    assert_ne!(first.operation_id, second.operation_id);
    assert_ne!(first.action_bundle_hash, second.action_bundle_hash);
    assert_ne!(first.certificate_hash, second.certificate_hash);

    // A capability armed for incident 8's operation refuses incident 7's certificate.
    let bounds = bounds_for(&second.certificate);
    assert_eq!(
        validate_certificate(
            &first.certificate,
            &bounds,
            &second.action_bundle_hash,
            CAPABILITY_NONCES[0],
            NOW
        ),
        Err(CertificateRefusal::ActionBundleMismatch)
    );
}

#[test]
fn replay_across_epochs_fails() {
    let (covenant, incident) = certified();
    let issued = issue(&covenant, &incident);
    let next_epoch = CapabilityBoundsV1 {
        circle_epoch: 2,
        ..bounds_for(&issued.certificate)
    };
    assert_eq!(
        validate_certificate(
            &issued.certificate,
            &next_epoch,
            &issued.action_bundle_hash,
            CAPABILITY_NONCES[0],
            NOW
        ),
        Err(CertificateRefusal::EpochMismatch)
    );
}

#[test]
fn replay_across_policies_fails() {
    let (covenant, incident) = certified();
    let issued = issue(&covenant, &incident);
    let other_policy = CapabilityBoundsV1 {
        policy_id: sha256(b"a different policy"),
        ..bounds_for(&issued.certificate)
    };
    assert_eq!(
        validate_certificate(
            &issued.certificate,
            &other_policy,
            &issued.action_bundle_hash,
            CAPABILITY_NONCES[0],
            NOW
        ),
        Err(CertificateRefusal::PolicyMismatch)
    );
}

#[test]
fn replay_across_clusters_fails() {
    let (covenant, incident) = certified();
    let issued = issue(&covenant, &incident);
    let other_cluster = CapabilityBoundsV1 {
        cluster_genesis_hash: OTHER_CLUSTER,
        ..bounds_for(&issued.certificate)
    };
    assert_eq!(
        validate_certificate(
            &issued.certificate,
            &other_cluster,
            &issued.action_bundle_hash,
            CAPABILITY_NONCES[0],
            NOW
        ),
        Err(CertificateRefusal::ClusterMismatch)
    );
}

#[test]
fn replaying_a_consumed_operation_against_the_same_capability_fails() {
    let (covenant, incident) = certified();
    let issued = issue(&covenant, &incident);
    let consumed = CapabilityBoundsV1 {
        last_operation_id: issued.operation_id,
        ..bounds_for(&issued.certificate)
    };
    assert_eq!(
        validate_certificate(
            &issued.certificate,
            &consumed,
            &issued.action_bundle_hash,
            CAPABILITY_NONCES[0],
            NOW
        ),
        Err(CertificateRefusal::OperationAlreadyConsumed)
    );
}

#[test]
fn a_different_certificate_nonce_produces_an_entirely_different_operation() {
    let (covenant, incident) = certified();
    let first = issue(&covenant, &incident);
    let second = certify(
        &covenant,
        &incident,
        ZeroizationState::CLEAN,
        CERTIFICATE_NONCE + 1,
        &CAPABILITY_NONCES,
        &resolved_addresses(),
        NOW,
    )
    .expect("certifies");

    assert_ne!(first.operation_id, second.operation_id);
    assert_ne!(first.action_bundle_hash, second.action_bundle_hash);
    assert_ne!(first.certificate_hash, second.certificate_hash);
}

// ---------------------------------------------------------------- exhaustive

#[test]
fn every_operation_input_is_load_bearing() {
    let (_, incident) = certified();
    let base = operation_inputs_for(&incident, CERTIFICATE_NONCE);
    let baseline = operation_id(&base);

    let mutations: Vec<Mutation> = vec![
        (
            "cluster_genesis_hash",
            Box::new(|i: &mut OperationInputsV1| i.cluster_genesis_hash = OTHER_CLUSTER),
        ),
        (
            "covenant",
            Box::new(|i: &mut OperationInputsV1| i.covenant = Address::from_seed(0xEE)),
        ),
        (
            "circle_epoch",
            Box::new(|i: &mut OperationInputsV1| i.circle_epoch += 1),
        ),
        (
            "incident_id",
            Box::new(|i: &mut OperationInputsV1| i.incident_id += 1),
        ),
        (
            "policy_id",
            Box::new(|i: &mut OperationInputsV1| i.policy_id = sha256(b"x")),
        ),
        (
            "member_set_hash",
            Box::new(|i: &mut OperationInputsV1| i.member_set_hash = sha256(b"x")),
        ),
        (
            "action_bundle_template_hash",
            Box::new(|i: &mut OperationInputsV1| i.action_bundle_template_hash = sha256(b"x")),
        ),
        (
            "certificate_nonce",
            Box::new(|i: &mut OperationInputsV1| i.certificate_nonce += 1),
        ),
    ];

    let mut seen: Vec<Digest32> = vec![baseline];
    for (name, mutate) in mutations {
        let mut mutated = base;
        mutate(&mut mutated);
        let digest = operation_id(&mutated);
        assert_ne!(
            digest, baseline,
            "{name} is not load-bearing in the operation id"
        );
        assert!(
            !seen.contains(&digest),
            "{name} collided with an earlier mutation"
        );
        seen.push(digest);
    }
}

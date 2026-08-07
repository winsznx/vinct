//! Generates the canonical cross-language test vectors.
//!
//! Each vector carries three things: the structured fields, the exact Borsh preimage as
//! hex, and the SHA-256 digest as hex. A verifier that only checked `sha256(preimage) ==
//! digest` would prove nothing about its own encoder, so the TypeScript side rebuilds the
//! preimage from the structured fields and compares bytes. Rust stays authoritative; the
//! vectors are how another language proves it agrees.
//!
//!   cargo run -p vinct-reference --features vectors --bin gen-vectors

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use vinct_reference::fixtures::*;
use vinct_reference::{certify, evaluate_incident, submit_attestation, EvaluationOutcome};
use vinct_types::action::*;
use vinct_types::attestation::{AttestationV1, Decision};
use vinct_types::covenant::*;
use vinct_types::domains;
use vinct_types::hash::{domain, preimage_and_hash, sha256, Digest32};
use vinct_types::policy::policies_hash;
use vinct_types::recovery::recovery_operation_id;
use vinct_types::zeroize::ZeroizationState;
use vinct_types::Address;

const OPENED: u64 = 1_000;
const NOW: u64 = 1_100;

fn hex32(bytes: &Digest32) -> String {
    hex::encode(bytes)
}

fn address_hex(address: &Address) -> String {
    hex::encode(address.as_bytes())
}

/// A vector entry: structured fields, exact preimage, and digest.
fn entry<T: borsh::BorshSerialize>(name: &str, value: &T, fields: Value) -> Value {
    let (preimage, digest) = preimage_and_hash(value).expect("fixture serializes");
    json!({
        "name": name,
        "fields": fields,
        "borsh_hex": hex::encode(&preimage),
        "borsh_len": preimage.len(),
        "sha256": hex::encode(digest),
    })
}

fn account_meta_json(meta: &CanonicalAccountMetaV1) -> Value {
    json!({
        "pubkey": address_hex(&meta.pubkey),
        "is_signer": meta.is_signer,
        "is_writable": meta.is_writable,
    })
}

fn template_meta_json(meta: &TemplateAccountMetaV1) -> Value {
    json!({
        "role": match meta.role {
            AccountRoleV1::Fixed => "fixed",
            AccountRoleV1::AdapterReceipt => "adapter_receipt",
            AccountRoleV1::SettlementReceipt => "settlement_receipt",
            AccountRoleV1::Certificate => "certificate",
        },
        "pubkey": address_hex(&meta.pubkey),
        "is_signer": meta.is_signer,
        "is_writable": meta.is_writable,
    })
}

fn effect_limit_json(limit: &EffectLimitV1) -> Value {
    json!({
        "may_pause": limit.may_pause,
        "may_unpause": limit.may_unpause,
        "max_value_moved": limit.max_value_moved.to_string(),
    })
}

fn action_json(action: &CanonicalActionV1) -> Value {
    json!({
        "action_index": action.action_index,
        "adapter_program_id": address_hex(&action.adapter_program_id),
        "adapter_version": action.adapter_version,
        "adapter_capability": address_hex(&action.adapter_capability),
        "target_program_id": address_hex(&action.target_program_id),
        "instruction_discriminator": hex::encode(action.instruction_discriminator),
        "account_metas": action.account_metas.iter().map(account_meta_json).collect::<Vec<_>>(),
        "instruction_data": hex::encode(&action.instruction_data),
        "effect_limit": effect_limit_json(&action.effect_limit),
        "capability_nonce": action.capability_nonce.to_string(),
    })
}

fn template_action_json(action: &ActionTemplateV1) -> Value {
    json!({
        "domain": hex32(&action.domain),
        "action_index": action.action_index,
        "adapter_program_id": address_hex(&action.adapter_program_id),
        "adapter_version": action.adapter_version,
        "adapter_capability": address_hex(&action.adapter_capability),
        "target_program_id": address_hex(&action.target_program_id),
        "instruction_discriminator": hex::encode(action.instruction_discriminator),
        "account_metas": action.account_metas.iter().map(template_meta_json).collect::<Vec<_>>(),
        "instruction_data": hex::encode(&action.instruction_data),
        "effect_limit": effect_limit_json(&action.effect_limit),
    })
}

fn member_json(member: &MemberV1) -> Value {
    json!({
        "domain": hex32(&member.domain),
        "member": address_hex(&member.member),
        "role": match member.role {
            MemberRole::Protocol => "protocol",
            MemberRole::Responder => "responder",
            MemberRole::Steward => "steward",
        },
        "adapter_capability": address_hex(&member.adapter_capability),
        "adapter_version": member.adapter_version,
    })
}

/// Builds the certified fixture operation.
fn certified_operation() -> vinct_reference::CertifiedOperation {
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
    certify(
        &covenant,
        &incident,
        ZeroizationState::CLEAN,
        CERTIFICATE_NONCE,
        &CAPABILITY_NONCES,
        &resolved_addresses(),
        NOW,
    )
    .expect("certifies")
}

/// Mutation vectors: each entry names a change and the digest it must produce.
///
/// The TypeScript side applies the same mutation to its own decoded structure and asserts
/// it lands on the same digest. That catches an encoder that happens to agree on the
/// baseline but disagrees on, say, boolean or vector-length encoding.
fn bundle_mutations(base: &ActionBundleV1) -> Value {
    let mut cases = Vec::new();

    let mut push = |name: &str, mutate: &dyn Fn(&mut ActionBundleV1)| {
        let mut mutated = base.clone();
        mutate(&mut mutated);
        match mutated.hash() {
            Ok(digest) => {
                let (preimage, _) = preimage_and_hash(&mutated).expect("serializes");
                cases.push(json!({
                    "mutation": name,
                    "rejected": false,
                    "borsh_hex": hex::encode(preimage),
                    "sha256": hex::encode(digest),
                }));
            }
            Err(error) => cases.push(json!({
                "mutation": name,
                "rejected": true,
                "reason": error.to_string(),
            })),
        }
    };

    push("cluster_genesis_hash", &|b| {
        b.cluster_genesis_hash = OTHER_CLUSTER
    });
    push("circle_epoch", &|b| b.circle_epoch += 1);
    push("incident_id", &|b| b.incident_id += 1);
    push("policy_id", &|b| b.policy_id = sha256(b"mutated policy"));
    push("member_set_hash", &|b| {
        b.member_set_hash = sha256(b"mutated members")
    });
    push("bundle_expiry_slot", &|b| b.bundle_expiry_slot += 1);
    push("operation_id", &|b| {
        b.operation_id = sha256(b"mutated operation")
    });
    push("adapter_version", &|b| b.actions[0].adapter_version += 1);
    push("capability_nonce", &|b| b.actions[0].capability_nonce += 1);
    push("instruction_discriminator", &|b| {
        b.actions[0].instruction_discriminator[0] ^= 0xFF
    });
    push("instruction_data_byte", &|b| {
        b.actions[0].instruction_data[0] ^= 0x01
    });
    push("instruction_data_appended", &|b| {
        b.actions[0].instruction_data.push(0x00)
    });
    push("effect_limit_may_unpause", &|b| {
        b.actions[0].effect_limit.may_unpause = true
    });
    push("effect_limit_max_value", &|b| {
        b.actions[0].effect_limit.max_value_moved = 1
    });
    push("target_program_id", &|b| {
        b.actions[0].target_program_id = Address::from_seed(0xEE)
    });
    push("adapter_capability", &|b| {
        b.actions[0].adapter_capability = Address::from_seed(0xEE)
    });
    push("account_meta_swap", &|b| {
        b.actions[0].account_metas.swap(1, 2)
    });
    push("account_meta_sorted", &|b| {
        b.actions[0].account_metas.sort_by_key(|m| m.pubkey)
    });
    push("account_key", &|b| {
        b.actions[0].account_metas[2].pubkey = Address::from_seed(0xEE)
    });
    push("account_signer_flag", &|b| {
        b.actions[0].account_metas[2].is_signer = !b.actions[0].account_metas[2].is_signer
    });
    push("account_writable_flag", &|b| {
        b.actions[0].account_metas[2].is_writable = !b.actions[0].account_metas[2].is_writable
    });
    push("account_meta_appended", &|b| {
        b.actions[0].account_metas.push(CanonicalAccountMetaV1 {
            pubkey: Address::from_seed(0xFF),
            is_signer: false,
            is_writable: true,
        })
    });
    push("action_swap_without_reindex", &|b| b.actions.swap(0, 1));
    push("duplicate_action_index", &|b| b.actions[1].action_index = 0);
    push("action_indices_not_zero_based", &|b| {
        for (position, action) in b.actions.iter_mut().enumerate() {
            action.action_index = position as u16 + 1;
        }
    });
    push("empty_actions", &|b| b.actions.clear());

    Value::Array(cases)
}

fn main() {
    let covenant = covenant_snapshot();
    let members = member_set();
    let policy = policy();
    let template = bundle_template();
    let claim = incident_claim();
    let issued = certified_operation();
    let snapshot = incident_snapshot(7, OPENED);

    let operation_inputs = OperationInputsV1 {
        cluster_genesis_hash: snapshot.cluster_genesis_hash,
        covenant: snapshot.covenant,
        circle_epoch: snapshot.circle_epoch,
        incident_id: snapshot.incident_id,
        policy_id: snapshot.policy_id,
        member_set_hash: snapshot.member_set_hash,
        action_bundle_template_hash: snapshot.action_bundle_template_hash,
        certificate_nonce: CERTIFICATE_NONCE,
    };

    let attestation = AttestationV1::new(COVENANT, 1, 7, PROTOCOL_A, Decision::Approve, 1, NOW);

    let covenant_digest = CovenantDigestV1::new(
        FIXTURE_CLUSTER,
        COVENANT,
        covenant.circle_epoch,
        STEWARD,
        members.hash().expect("hashes"),
        policies_hash(std::slice::from_ref(&policy)).expect("hashes"),
        covenant_adapter_set_hash(),
        covenant.valid_from_slot,
        covenant.expires_at_slot,
    );

    let recovery_id = recovery_operation_id(&issued.operation_id, &COVENANT, 1, 7, 99);

    let vectors = json!({
        "schema": "vinct-canonical-vectors/1",
        "generated_by": "cargo run -p vinct-reference --features vectors --bin gen-vectors",
        "note": "Rust is authoritative. A verifier must rebuild every borsh_hex from the structured fields and match byte for byte, not merely re-hash the supplied preimage.",

        "domains": domains_vector(),

        "members": {
            "entries": members.members.iter().map(|m| {
                entry("member_v1", m, member_json(m))
            }).collect::<Vec<_>>(),
            "member_set_hash": hex32(&members.hash().expect("hashes")),
            "ordering_rule": "ascending by member address; a set that arrives out of order is rejected, never sorted",
        },

        "policy": entry("response_policy_v1", &policy, json!({
            "domain": hex32(&policy.domain),
            "policy_id": hex32(&policy.policy_id),
            "action_category": "pause_new_borrowing",
            "dependency_namespace": "price_feed",
            "dependency_id": hex32(&policy.dependency_id),
            "eligible_member_set_hash": hex32(&policy.eligible_member_set_hash),
            "required_approvals": policy.required_approvals,
            "maximum_rejections": policy.maximum_rejections,
            "required_roles": ["protocol"],
            "response_window_slots": policy.response_window_slots.to_string(),
            "certificate_ttl_slots": policy.certificate_ttl_slots.to_string(),
            "action_bundle_template_hash": hex32(&policy.action_bundle_template_hash),
            "version": policy.version,
        })),

        "policies_hash": hex32(&policies_hash(std::slice::from_ref(&policy)).expect("hashes")),
        "adapter_set_hash": hex32(&covenant_adapter_set_hash()),

        "action_templates": template.actions.iter().map(|a| {
            entry("action_template_v1", a, template_action_json(a))
        }).collect::<Vec<_>>(),

        "bundle_template": entry("action_bundle_template_v1", &template, json!({
            "actions": template.actions.iter().map(template_action_json).collect::<Vec<_>>(),
        })),
        "bundle_template_hash": hex32(&template.hash().expect("hashes")),

        "operation_id": {
            "note": "Derived from the registered template hash, not the concrete bundle hash. See docs/decision-log.md D-0012.",
            "inputs": {
                "domain": hex32(&domain(domains::OPERATION_V1)),
                "cluster_genesis_hash": hex32(&operation_inputs.cluster_genesis_hash),
                "covenant": address_hex(&operation_inputs.covenant),
                "circle_epoch": operation_inputs.circle_epoch.to_string(),
                "incident_id": operation_inputs.incident_id.to_string(),
                "policy_id": hex32(&operation_inputs.policy_id),
                "member_set_hash": hex32(&operation_inputs.member_set_hash),
                "action_bundle_template_hash": hex32(&operation_inputs.action_bundle_template_hash),
                "certificate_nonce": operation_inputs.certificate_nonce.to_string(),
            },
            "encoding": "domain || cluster || covenant || epoch_le64 || incident_le64 || policy || member_set || template || nonce_le64",
            "sha256": hex32(&issued.operation_id),
        },

        "action_bundle": entry("action_bundle_v1", &issued.bundle, json!({
            "domain": hex32(&issued.bundle.domain),
            "cluster_genesis_hash": hex32(&issued.bundle.cluster_genesis_hash),
            "covenant": address_hex(&issued.bundle.covenant),
            "circle_epoch": issued.bundle.circle_epoch.to_string(),
            "incident_id": issued.bundle.incident_id.to_string(),
            "policy_id": hex32(&issued.bundle.policy_id),
            "member_set_hash": hex32(&issued.bundle.member_set_hash),
            "bundle_expiry_slot": issued.bundle.bundle_expiry_slot.to_string(),
            "operation_id": hex32(&issued.bundle.operation_id),
            "actions": issued.bundle.actions.iter().map(action_json).collect::<Vec<_>>(),
        })),

        "action_bundle_mutations": bundle_mutations(&issued.bundle),

        "certificate": entry("certificate_v1", &issued.certificate, json!({
            "domain": hex32(&issued.certificate.domain),
            "cluster_genesis_hash": hex32(&issued.certificate.cluster_genesis_hash),
            "covenant": address_hex(&issued.certificate.covenant),
            "circle_epoch": issued.certificate.circle_epoch.to_string(),
            "incident_id": issued.certificate.incident_id.to_string(),
            "policy_id": hex32(&issued.certificate.policy_id),
            "member_set_hash": hex32(&issued.certificate.member_set_hash),
            "action_bundle_hash": hex32(&issued.certificate.action_bundle_hash),
            "operation_id": hex32(&issued.certificate.operation_id),
            "certificate_nonce": issued.certificate.certificate_nonce.to_string(),
            "approval_count": issued.certificate.approval_count,
            "rejection_count": issued.certificate.rejection_count,
            "certified_at_slot": issued.certificate.certified_at_slot.to_string(),
            "expires_at_slot": issued.certificate.expires_at_slot.to_string(),
        })),

        "covenant_digest": entry("covenant_digest_v1", &covenant_digest, json!({
            "domain": hex32(&covenant_digest.domain),
            "cluster_genesis_hash": hex32(&covenant_digest.cluster_genesis_hash),
            "covenant": address_hex(&covenant_digest.covenant),
            "circle_epoch": covenant_digest.circle_epoch.to_string(),
            "steward": address_hex(&covenant_digest.steward),
            "member_set_hash": hex32(&covenant_digest.member_set_hash),
            "policies_hash": hex32(&covenant_digest.policies_hash),
            "adapter_set_hash": hex32(&covenant_digest.adapter_set_hash),
            "valid_from_slot": covenant_digest.valid_from_slot.to_string(),
            "expires_at_slot": covenant_digest.expires_at_slot.to_string(),
        })),

        "attestation": entry("attestation_v1", &attestation, json!({
            "domain": hex32(&attestation.domain),
            "covenant": address_hex(&attestation.covenant),
            "circle_epoch": attestation.circle_epoch.to_string(),
            "incident_id": attestation.incident_id.to_string(),
            "member": address_hex(&attestation.member),
            "decision": "approve",
            "submission_nonce": attestation.submission_nonce.to_string(),
            "submitted_at_slot": attestation.submitted_at_slot.to_string(),
            "state": "submitted",
        })),

        "incident_claim": entry("incident_claim_v1", &claim, json!({
            "domain": hex32(&claim.domain),
            "dependency_namespace": "price_feed",
            "dependency_id": hex32(&claim.dependency_id),
            "observation_window_start": claim.observation_window_start.to_string(),
            "observation_window_end": claim.observation_window_end.to_string(),
            "claim_schema_hash": hex32(&claim.claim_schema_hash),
            "private_evidence_digest": hex32(&claim.private_evidence_digest),
            "signal_category": "oracle_deviation",
            "confidence_bucket": "high",
            "requested_action_category": "pause_new_borrowing",
            "submitter": address_hex(&claim.submitter),
            "submission_nonce": claim.submission_nonce.to_string(),
        })),

        "recovery_operation_id": {
            "inputs": {
                "domain": hex32(&domain(domains::RECOVERY_V1)),
                "original_operation_id": hex32(&issued.operation_id),
                "covenant": address_hex(&COVENANT),
                "circle_epoch": "1",
                "incident_id": "7",
                "recovery_nonce": "99",
            },
            "encoding": "domain || original_operation || covenant || epoch_le64 || incident_le64 || recovery_nonce_le64",
            "sha256": hex32(&recovery_id),
            "differs_from_original": recovery_id != issued.operation_id,
        },
    });

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/test-vectors")
        .join("canonical-vectors.json");
    fs::create_dir_all(path.parent().expect("has a parent")).expect("creates directory");
    fs::write(
        &path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&vectors).expect("serializes")
        ),
    )
    .expect("writes vectors");
    println!("wrote {}", path.display());
}

fn domains_vector() -> Value {
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
    Value::Array(
        labels
            .iter()
            .map(|label| {
                json!({
                    "label": label,
                    "sha256": hex::encode(domain(label)),
                })
            })
            .collect(),
    )
}

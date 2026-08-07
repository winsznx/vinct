//! The canonical three-member covenant.
//!
//! One fixture builder feeds the unit tests, the exhaustive enumeration, the property
//! tests, and the cross-language vectors. If they each built their own covenant, a vector
//! could pass while the model it claims to describe had drifted.
//!
//! Every address here is deterministic and recognisable. None of them is a real key, and
//! none of them is derivable to a signing key, so committing them leaks nothing.

use vinct_types::action::{
    AccountRoleV1, ActionBundleTemplateV1, ActionTemplateV1, EffectLimitV1, ResolvedAddressesV1,
    TemplateAccountMetaV1,
};
use vinct_types::address::Address;
use vinct_types::covenant::{adapter_set_hash, MemberRole, MemberSetV1, MemberV1};
use vinct_types::hash::{sha256, Digest32};
use vinct_types::incident::{
    ConfidenceBucket, IncidentClaimV1, IncidentSnapshotV1, SignalCategory,
};
use vinct_types::policy::{ActionCategory, DependencyNamespace, ResponsePolicyV1};

use crate::model::{CovenantSnapshot, IncidentState};

/// Cluster the fixture is bound to. A recognisable stand-in, never a real genesis hash.
pub const FIXTURE_CLUSTER: Digest32 = [0x11; 32];

/// A different cluster, for cross-cluster replay tests.
pub const OTHER_CLUSTER: Digest32 = [0x22; 32];

/// The covenant account.
pub const COVENANT: Address = Address::from_seed(0xC0);
/// The steward. Convenes formation, holds no protocol authority.
pub const STEWARD: Address = Address::from_seed(0x5D);

/// Protocol A's authority.
pub const PROTOCOL_A: Address = Address::from_seed(0xA1);
/// Protocol B's authority.
pub const PROTOCOL_B: Address = Address::from_seed(0xB1);
/// Protocol C's authority.
pub const PROTOCOL_C: Address = Address::from_seed(0xC1);

/// Protocol A's adapter capability.
pub const CAPABILITY_A: Address = Address::from_seed(0xA2);
/// Protocol B's adapter capability.
pub const CAPABILITY_B: Address = Address::from_seed(0xB2);
/// Protocol C's adapter capability.
pub const CAPABILITY_C: Address = Address::from_seed(0xC2);

/// Protocol A's market account.
pub const MARKET_A: Address = Address::from_seed(0xA3);
/// Protocol B's market account.
pub const MARKET_B: Address = Address::from_seed(0xB3);
/// Protocol C's market account.
pub const MARKET_C: Address = Address::from_seed(0xC3);

/// The shared adapter program. Each protocol owns its own capability under it.
pub const ADAPTER_PROGRAM: Address = Address::from_seed(0xAD);
/// The reference protocol program the adapters call.
pub const MOCK_PROTOCOL_PROGRAM: Address = Address::from_seed(0x4C);
/// The VINCT core program.
pub const CORE_PROGRAM: Address = Address::from_seed(0x0C);

/// Resolved adapter receipt for protocol A. Deterministic stand-in for a real PDA.
pub const RECEIPT_A: Address = Address::from_seed(0xA4);
/// Resolved adapter receipt for protocol B.
pub const RECEIPT_B: Address = Address::from_seed(0xB4);
/// Resolved adapter receipt for protocol C.
pub const RECEIPT_C: Address = Address::from_seed(0xC4);
/// Resolved settlement receipt for the operation.
pub const SETTLEMENT_RECEIPT: Address = Address::from_seed(0x5E);
/// Resolved certificate account for the operation.
pub const CERTIFICATE_ACCOUNT: Address = Address::from_seed(0xCE);

/// The adapter's `execute_bounded_action` discriminator.
pub const ADAPTER_EXECUTE_DISCRIMINATOR: [u8; 8] = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
/// The core's `finalize_settlement` discriminator.
pub const SETTLEMENT_DISCRIMINATOR: [u8; 8] = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18];

/// The covered dependency: a shared oracle fixture.
pub fn dependency_id() -> Digest32 {
    sha256(b"vinct-fixture-shared-oracle")
}

/// The policy identity.
pub fn policy_id() -> Digest32 {
    sha256(b"vinct-fixture-policy-pause-new-borrowing")
}

/// The evidence schema commitment.
pub fn claim_schema_hash() -> Digest32 {
    sha256(b"vinct-fixture-claim-schema-v1")
}

/// The three-member set: protocols A, B, and C.
pub fn member_set() -> MemberSetV1 {
    MemberSetV1::new(vec![
        MemberV1::new(PROTOCOL_A, MemberRole::Protocol, CAPABILITY_A, 1),
        MemberV1::new(PROTOCOL_B, MemberRole::Protocol, CAPABILITY_B, 1),
        MemberV1::new(PROTOCOL_C, MemberRole::Protocol, CAPABILITY_C, 1),
    ])
    .expect("fixture member set is well-formed")
}

/// One adapter action template.
///
/// The account order is the adapter instruction's real order and is never sorted:
/// certificate, capability, market, receipt. Swapping the market and the receipt would
/// make the adapter write its receipt into the market account, which is exactly the
/// substitution the ordered-meta commitment exists to catch.
pub fn adapter_template(
    action_index: u16,
    capability: Address,
    market: Address,
) -> ActionTemplateV1 {
    ActionTemplateV1::new(
        action_index,
        ADAPTER_PROGRAM,
        1,
        capability,
        MOCK_PROTOCOL_PROGRAM,
        ADAPTER_EXECUTE_DISCRIMINATOR,
        vec![
            TemplateAccountMetaV1::derived(AccountRoleV1::Certificate, false, false),
            TemplateAccountMetaV1::fixed(capability, false, true),
            TemplateAccountMetaV1::fixed(market, false, true),
            TemplateAccountMetaV1::derived(AccountRoleV1::AdapterReceipt, false, true),
        ],
        vec![
            ADAPTER_EXECUTE_DISCRIMINATOR[0],
            ADAPTER_EXECUTE_DISCRIMINATOR[1],
            action_index as u8,
        ],
        EffectLimitV1::PAUSE_ONLY,
    )
}

/// The final settlement-receipt action template.
pub fn settlement_template(action_index: u16) -> ActionTemplateV1 {
    ActionTemplateV1::new(
        action_index,
        CORE_PROGRAM,
        1,
        Address::from_seed(0x5F),
        CORE_PROGRAM,
        SETTLEMENT_DISCRIMINATOR,
        vec![
            TemplateAccountMetaV1::derived(AccountRoleV1::Certificate, false, false),
            TemplateAccountMetaV1::derived(AccountRoleV1::SettlementReceipt, false, true),
        ],
        SETTLEMENT_DISCRIMINATOR.to_vec(),
        EffectLimitV1 {
            may_pause: false,
            may_unpause: false,
            max_value_moved: 0,
        },
    )
}

/// The registered bundle: three adapter actions then the settlement receipt.
pub fn bundle_template() -> ActionBundleTemplateV1 {
    ActionBundleTemplateV1::new(vec![
        adapter_template(0, CAPABILITY_A, MARKET_A),
        adapter_template(1, CAPABILITY_B, MARKET_B),
        adapter_template(2, CAPABILITY_C, MARKET_C),
        settlement_template(3),
    ])
    .expect("fixture bundle template is well-formed")
}

/// The hackathon policy: two of three approvals, at most one rejection.
pub fn policy() -> ResponsePolicyV1 {
    let template_hash = bundle_template().hash().expect("fixture template hashes");
    ResponsePolicyV1::new(
        policy_id(),
        ActionCategory::PauseNewBorrowing,
        DependencyNamespace::PriceFeed,
        dependency_id(),
        member_set().hash().expect("fixture member set hashes"),
        2,
        1,
        vec![MemberRole::Protocol],
        300,
        600,
        template_hash,
    )
}

/// The full covenant snapshot.
pub fn covenant_snapshot() -> CovenantSnapshot {
    CovenantSnapshot {
        covenant: COVENANT,
        circle_epoch: 1,
        cluster_genesis_hash: FIXTURE_CLUSTER,
        steward: STEWARD,
        member_set: member_set(),
        policy: policy(),
        template: bundle_template(),
        valid_from_slot: 0,
        expires_at_slot: 1_000_000,
    }
}

/// The epoch's adapter-set commitment.
pub fn covenant_adapter_set_hash() -> Digest32 {
    adapter_set_hash(&[(CAPABILITY_A, 1), (CAPABILITY_B, 1), (CAPABILITY_C, 1)])
}

/// The private incident claim.
///
/// The evidence digest carries a recognisable marker. Phase 4's privacy sweep searches
/// public surfaces for it, so it has to be a value that could not appear by chance.
pub fn incident_claim() -> IncidentClaimV1 {
    IncidentClaimV1::new(
        DependencyNamespace::PriceFeed,
        dependency_id(),
        1_700_000_000,
        1_700_003_600,
        claim_schema_hash(),
        sha256(PRIVATE_FIXTURE_MARKER),
        SignalCategory::OracleDeviation,
        ConfidenceBucket::High,
        ActionCategory::PauseNewBorrowing,
        PROTOCOL_A,
        1,
    )
}

/// The unique marker seeded into private fixture payloads.
///
/// Phase 4 greps transaction messages, logs, base account data, browser storage, network
/// traces, application logs, and test artifacts for this exact string. Finding it outside
/// the permitted private path falsifies the privacy claim.
pub const PRIVATE_FIXTURE_MARKER: &[u8] = b"VINCT-PRIVATE-CANARY-8f3a1c47b92e5d60";

/// An incident opened at `opened_at_slot` under the fixture covenant.
pub fn incident_snapshot(incident_id: u64, opened_at_slot: u64) -> IncidentSnapshotV1 {
    let covenant = covenant_snapshot();
    IncidentSnapshotV1 {
        covenant: COVENANT,
        circle_epoch: covenant.circle_epoch,
        incident_id,
        policy_id: policy_id(),
        member_set_hash: covenant.member_set.hash().expect("member set hashes"),
        action_bundle_template_hash: covenant.template.hash().expect("template hashes"),
        cluster_genesis_hash: FIXTURE_CLUSTER,
        opened_at_slot,
        expires_at_slot: opened_at_slot + covenant.policy.response_window_slots,
        required_approvals: covenant.policy.required_approvals,
        maximum_rejections: covenant.policy.maximum_rejections,
        claim_digest: incident_claim().digest().expect("claim hashes"),
    }
}

/// A freshly opened incident.
pub fn incident_state(incident_id: u64, opened_at_slot: u64) -> IncidentState {
    IncidentState::open(incident_snapshot(incident_id, opened_at_slot))
}

/// The addresses the fixture template's derived slots resolve to.
pub fn resolved_addresses() -> ResolvedAddressesV1 {
    ResolvedAddressesV1 {
        adapter_receipts: vec![RECEIPT_A, RECEIPT_B, RECEIPT_C, SETTLEMENT_RECEIPT],
        settlement_receipt: Some(SETTLEMENT_RECEIPT),
        certificate: Some(CERTIFICATE_ACCOUNT),
    }
}

/// The capability nonces the fixture bundle consumes, one per action.
pub const CAPABILITY_NONCES: [u64; 4] = [7, 7, 7, 0];

/// The certificate nonce the fixture draws.
pub const CERTIFICATE_NONCE: u64 = 42;

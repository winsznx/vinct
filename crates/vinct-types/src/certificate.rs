//! The incident certificate: the one public object that authorises a bounded action.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::address::Address;
use crate::domains;
use crate::error::VinctTypesError;
use crate::hash::{domain, hash_borsh, Digest32};

/// A threshold certificate bound to exactly one action bundle.
///
/// Every field here is a binding an adapter checks before it will act. Dropping any one
/// of them creates a replay surface: without `cluster_genesis_hash` a devnet certificate
/// works on localnet, without `circle_epoch` a superseded membership still certifies,
/// without `action_bundle_hash` a valid certificate authorises a different instruction,
/// and without `operation_id` the same certificate pauses a protocol twice.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CertificateV1 {
    /// Domain separator for `VINCT_CERTIFICATE_V1`.
    pub domain: Digest32,
    /// The cluster this certificate is valid on.
    pub cluster_genesis_hash: Digest32,
    /// The covenant that issued it.
    pub covenant: Address,
    /// The epoch frozen at incident open.
    pub circle_epoch: u64,
    /// The incident it certifies.
    pub incident_id: u64,
    /// The policy that authorised it.
    pub policy_id: Digest32,
    /// The member set frozen at incident open.
    pub member_set_hash: Digest32,
    /// The concrete action bundle it authorises, and only that bundle.
    pub action_bundle_hash: Digest32,
    /// The operation identity every effect is idempotent against.
    pub operation_id: Digest32,
    /// The nonce drawn at certification.
    pub certificate_nonce: u64,
    /// Approvals counted at certification. Published only after the terminal scrub, and
    /// only as an aggregate.
    pub approval_count: u8,
    /// Rejections counted at certification.
    pub rejection_count: u8,
    /// Slot the threshold was reached.
    pub certified_at_slot: u64,
    /// Slot after which the certificate may no longer be settled.
    pub expires_at_slot: u64,
}

impl CertificateV1 {
    /// Builds a certificate with its domain separator already set.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cluster_genesis_hash: Digest32,
        covenant: Address,
        circle_epoch: u64,
        incident_id: u64,
        policy_id: Digest32,
        member_set_hash: Digest32,
        action_bundle_hash: Digest32,
        operation_id: Digest32,
        certificate_nonce: u64,
        approval_count: u8,
        rejection_count: u8,
        certified_at_slot: u64,
        expires_at_slot: u64,
    ) -> Self {
        Self {
            domain: domain(domains::CERTIFICATE_V1),
            cluster_genesis_hash,
            covenant,
            circle_epoch,
            incident_id,
            policy_id,
            member_set_hash,
            action_bundle_hash,
            operation_id,
            certificate_nonce,
            approval_count,
            rejection_count,
            certified_at_slot,
            expires_at_slot,
        }
    }

    /// The certificate hash.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }

    /// True when `now_slot` is at or past the certificate's expiry.
    pub fn is_expired(&self, now_slot: u64) -> bool {
        now_slot >= self.expires_at_slot
    }
}

/// Why an adapter refused a certificate.
///
/// The variants are ordered the way PRD section 14 orders adapter validation, so a
/// refusal names the first check that failed rather than a generic rejection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertificateRefusal {
    /// The certificate account is not owned by the expected VINCT core program.
    WrongOwner,
    /// The certificate is for a different cluster.
    ClusterMismatch,
    /// The certificate is for a different covenant.
    CovenantMismatch,
    /// The certificate is for a different epoch.
    EpochMismatch,
    /// The certificate is for a different policy.
    PolicyMismatch,
    /// The certificate's member set is not the one the capability was armed against.
    MemberSetMismatch,
    /// The certificate has expired.
    Expired,
    /// The certificate authorises a different action bundle.
    ActionBundleMismatch,
    /// The operation ID does not match the one being executed.
    OperationMismatch,
    /// The capability is not armed.
    CapabilityNotArmed,
    /// The capability is suspended.
    CapabilitySuspended,
    /// The capability was armed against a different adapter version.
    AdapterVersionMismatch,
    /// The instruction targets a program the capability does not authorise.
    TargetProgramMismatch,
    /// The instruction discriminator is not the authorised one.
    DiscriminatorMismatch,
    /// The ordered account metas do not match the armed template.
    AccountMetasMismatch,
    /// The instruction data does not match the armed bytes.
    InstructionDataMismatch,
    /// The action exceeds the capability's effect bound.
    EffectLimitExceeded,
    /// The capability nonce is not the expected one.
    CapabilityNonceMismatch,
    /// This operation has already been consumed by this capability.
    OperationAlreadyConsumed,
}

/// Runs the certificate-side portion of PRD section 14's validation order.
///
/// Everything checkable from the certificate and the capability's static bounds is
/// checked here so the reference model and the on-chain adapter cannot drift. The
/// remaining checks in that list are account-level facts an adapter must establish from
/// its own runtime: owner, PDA derivation, and prior consumption.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityBoundsV1 {
    /// Cluster the capability was armed on.
    pub cluster_genesis_hash: Digest32,
    /// Covenant the capability serves.
    pub covenant: Address,
    /// Epoch the capability was armed for.
    pub circle_epoch: u64,
    /// Policy the capability was armed for.
    pub policy_id: Digest32,
    /// Member set the capability was armed against.
    pub member_set_hash: Digest32,
    /// Adapter version.
    pub adapter_version: u16,
    /// Whether the protocol authority has armed it.
    pub armed: bool,
    /// Whether the protocol authority has suspended it.
    pub suspended: bool,
    /// The next nonce this capability expects.
    pub capability_nonce: u64,
    /// The last operation this capability consumed.
    pub last_operation_id: Digest32,
}

/// Validates a certificate against one capability's static bounds.
pub fn validate_certificate(
    certificate: &CertificateV1,
    bounds: &CapabilityBoundsV1,
    expected_action_bundle_hash: &Digest32,
    presented_capability_nonce: u64,
    now_slot: u64,
) -> Result<(), CertificateRefusal> {
    if certificate.cluster_genesis_hash != bounds.cluster_genesis_hash {
        return Err(CertificateRefusal::ClusterMismatch);
    }
    if certificate.covenant != bounds.covenant {
        return Err(CertificateRefusal::CovenantMismatch);
    }
    if certificate.circle_epoch != bounds.circle_epoch {
        return Err(CertificateRefusal::EpochMismatch);
    }
    if certificate.policy_id != bounds.policy_id {
        return Err(CertificateRefusal::PolicyMismatch);
    }
    if certificate.member_set_hash != bounds.member_set_hash {
        return Err(CertificateRefusal::MemberSetMismatch);
    }
    if certificate.is_expired(now_slot) {
        return Err(CertificateRefusal::Expired);
    }
    if &certificate.action_bundle_hash != expected_action_bundle_hash {
        return Err(CertificateRefusal::ActionBundleMismatch);
    }
    if !bounds.armed {
        return Err(CertificateRefusal::CapabilityNotArmed);
    }
    if bounds.suspended {
        return Err(CertificateRefusal::CapabilitySuspended);
    }
    if presented_capability_nonce != bounds.capability_nonce {
        return Err(CertificateRefusal::CapabilityNonceMismatch);
    }
    if bounds.last_operation_id == certificate.operation_id {
        return Err(CertificateRefusal::OperationAlreadyConsumed);
    }
    Ok(())
}

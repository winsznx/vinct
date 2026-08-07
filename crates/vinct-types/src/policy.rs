//! Response policy: the pre-agreed conditions under which a certificate may be issued.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::covenant::MemberRole;
use crate::domains;
use crate::error::VinctTypesError;
use crate::hash::{domain, hash_borsh, hash_digest_list, Digest32};
use crate::limits::MAX_POLICIES;

/// The bounded action category a policy authorises.
///
/// This enum is deliberately closed. A new category is a covenant amendment and a new
/// epoch, not a runtime string.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ActionCategory {
    /// Stop accepting new borrows. The only category the hackathon build authorises.
    PauseNewBorrowing,
}

/// The namespace a covered dependency is identified in.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DependencyNamespace {
    /// A Solana program address.
    SolanaProgram,
    /// A price feed identity.
    PriceFeed,
    /// A bridge or messaging endpoint.
    Bridge,
    /// A shared off-chain service, identified by a hash of its canonical name.
    OffchainService,
}

/// A frozen response policy.
///
/// Mirrors PRD section 13. `action_bundle_template_hash` is the commitment to the
/// registered action template, which is operation-independent. The concrete per-incident
/// bundle hash lives on the certificate.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ResponsePolicyV1 {
    /// Domain separator for `VINCT_POLICY_V1`.
    pub domain: Digest32,
    /// Stable identity of this policy within its covenant.
    pub policy_id: Digest32,
    /// The category of action this policy authorises.
    pub action_category: ActionCategory,
    /// The namespace of the covered dependency.
    pub dependency_namespace: DependencyNamespace,
    /// The covered dependency's identity.
    pub dependency_id: Digest32,
    /// Commitment to the member set eligible under this policy.
    pub eligible_member_set_hash: Digest32,
    /// Approvals required to certify.
    pub required_approvals: u8,
    /// Rejections that block certification once reached.
    pub maximum_rejections: u8,
    /// Roles that may attest. Empty means every active member may.
    pub required_roles: Vec<MemberRole>,
    /// Slots an incident stays open collecting attestations.
    pub response_window_slots: u64,
    /// Slots a certificate remains valid for settlement.
    pub certificate_ttl_slots: u64,
    /// Commitment to the registered action template.
    pub action_bundle_template_hash: Digest32,
    /// Policy layout version.
    pub version: u16,
}

impl ResponsePolicyV1 {
    /// Builds a policy with its domain separator already set.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        policy_id: Digest32,
        action_category: ActionCategory,
        dependency_namespace: DependencyNamespace,
        dependency_id: Digest32,
        eligible_member_set_hash: Digest32,
        required_approvals: u8,
        maximum_rejections: u8,
        required_roles: Vec<MemberRole>,
        response_window_slots: u64,
        certificate_ttl_slots: u64,
        action_bundle_template_hash: Digest32,
    ) -> Self {
        Self {
            domain: domain(domains::POLICY_V1),
            policy_id,
            action_category,
            dependency_namespace,
            dependency_id,
            eligible_member_set_hash,
            required_approvals,
            maximum_rejections,
            required_roles,
            response_window_slots,
            certificate_ttl_slots,
            action_bundle_template_hash,
            version: 1,
        }
    }

    /// Rejects a policy that could never behave correctly.
    ///
    /// A zero threshold would certify with no approval at all. A zero response window
    /// closes before an attestation can arrive. A zero certificate lifetime expires
    /// before settlement can be attempted. Each is a configuration mistake that must fail
    /// at formation, not during an incident.
    pub fn validate(&self, eligible_member_count: usize) -> Result<(), VinctTypesError> {
        if self.required_approvals == 0 {
            return Err(VinctTypesError::ZeroRequiredApprovals);
        }
        if usize::from(self.required_approvals) > eligible_member_count {
            return Err(VinctTypesError::ThresholdExceedsMemberCount);
        }
        if self.response_window_slots == 0 {
            return Err(VinctTypesError::ZeroResponseWindow);
        }
        if self.certificate_ttl_slots == 0 {
            return Err(VinctTypesError::ZeroCertificateLifetime);
        }
        Ok(())
    }

    /// This policy's digest.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }

    /// True when the role is permitted to attest under this policy.
    pub fn role_may_attest(&self, role: MemberRole) -> bool {
        self.required_roles.is_empty() || self.required_roles.contains(&role)
    }
}

/// Commitment to every policy attached to a covenant epoch.
///
/// Ordered by policy ID so the commitment does not depend on drafting order.
pub fn policies_hash(policies: &[ResponsePolicyV1]) -> Result<Digest32, VinctTypesError> {
    if policies.len() > MAX_POLICIES {
        return Err(VinctTypesError::TooManyActions);
    }
    let mut digests = policies
        .iter()
        .map(|p| p.hash().map(|h| (p.policy_id, h)))
        .collect::<Result<Vec<_>, _>>()?;
    digests.sort_by_key(|(policy_id, _)| *policy_id);
    let ordered: Vec<Digest32> = digests.into_iter().map(|(_, h)| h).collect();
    Ok(hash_digest_list(&domain(domains::POLICY_SET_V1), &ordered))
}

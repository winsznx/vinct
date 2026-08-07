//! Covenant membership, epochs, and the covenant digest.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::address::Address;
use crate::domains;
use crate::error::VinctTypesError;
use crate::hash::{domain, hash_borsh, hash_digest_list, Digest32};
use crate::limits::MAX_MEMBERS;

/// What a member is entitled to do inside a covenant epoch.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemberRole {
    /// A protocol that owns an adapter and may attest.
    Protocol,
    /// A security responder that may attest but owns no adapter.
    Responder,
    /// The steward. Convenes formation and never gains protocol authority.
    Steward,
}

/// A member's standing within the frozen snapshot of one incident.
///
/// Status is frozen per incident. Removing a member takes effect in a future epoch;
/// only quarantine acts on an incident already in flight.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemberStatus {
    /// Eligible to attest.
    Active,
    /// Present in the snapshot but not eligible. Counts toward neither approvals nor the
    /// threshold denominator, and never lowers the threshold.
    Quarantined,
}

/// One covenant member, as committed into the member-set hash.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemberV1 {
    /// Domain separator for `VINCT_MEMBER_V1`.
    pub domain: Digest32,
    /// The member's authority address.
    pub member: Address,
    /// The role this member holds in this epoch.
    pub role: MemberRole,
    /// The adapter capability this member owns, or [`Address::ZERO`] when it owns none.
    pub adapter_capability: Address,
    /// The adapter version this member has armed. Zero when it owns no adapter.
    pub adapter_version: u16,
}

impl MemberV1 {
    /// Builds a member commitment.
    pub fn new(
        member: Address,
        role: MemberRole,
        adapter_capability: Address,
        adapter_version: u16,
    ) -> Self {
        Self {
            domain: domain(domains::MEMBER_V1),
            member,
            role,
            adapter_capability,
            adapter_version,
        }
    }

    /// This member's digest.
    pub fn digest(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }
}

/// The full member set for one covenant epoch.
///
/// Members are held in strictly ascending address order. That is a canonical *storage*
/// order for a set, chosen so two clients that agree on membership always agree on the
/// hash. It is unrelated to account-meta order, which is semantic and never sorted.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct MemberSetV1 {
    /// Members, ascending by address.
    pub members: Vec<MemberV1>,
}

impl MemberSetV1 {
    /// Builds a member set from an arbitrary ordering, imposing the canonical order.
    ///
    /// Rejects an empty set, an oversized set, and duplicate addresses. A duplicate is
    /// rejected rather than deduplicated: a caller that submitted one is wrong about who
    /// the members are, and silently fixing it would let two different intended sets
    /// produce the same hash.
    pub fn new(mut members: Vec<MemberV1>) -> Result<Self, VinctTypesError> {
        if members.is_empty() {
            return Err(VinctTypesError::EmptyMemberSet);
        }
        if members.len() > MAX_MEMBERS {
            return Err(VinctTypesError::TooManyMembers);
        }
        members.sort_by_key(|m| m.member);
        for pair in members.windows(2) {
            if pair[0].member == pair[1].member {
                return Err(VinctTypesError::DuplicateMember);
            }
        }
        Ok(Self { members })
    }

    /// Validates an already-ordered member set without reordering it.
    ///
    /// Used on decode. A set that arrives out of order is rejected instead of being
    /// sorted, so a tampered encoding cannot be normalised into a valid one.
    pub fn validate(&self) -> Result<(), VinctTypesError> {
        if self.members.is_empty() {
            return Err(VinctTypesError::EmptyMemberSet);
        }
        if self.members.len() > MAX_MEMBERS {
            return Err(VinctTypesError::TooManyMembers);
        }
        for pair in self.members.windows(2) {
            if pair[0].member == pair[1].member {
                return Err(VinctTypesError::DuplicateMember);
            }
            if pair[0].member > pair[1].member {
                return Err(VinctTypesError::MemberSetNotCanonicallyOrdered);
            }
        }
        Ok(())
    }

    /// The member-set hash committed by the covenant and frozen per incident.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        self.validate()?;
        let digests = self
            .members
            .iter()
            .map(|m| m.digest())
            .collect::<Result<Vec<_>, _>>()?;
        Ok(hash_digest_list(&domain(domains::MEMBER_SET_V1), &digests))
    }

    /// Looks up a member by address.
    pub fn find(&self, member: &Address) -> Option<&MemberV1> {
        self.members.iter().find(|m| &m.member == member)
    }

    /// Number of members in the set, regardless of status.
    pub fn len(&self) -> usize {
        self.members.len()
    }

    /// True when the set holds no members. A validated set never does.
    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }
}

/// The covenant digest every ratification authority signs.
///
/// Mirrors PRD section 12.2 field for field.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CovenantDigestV1 {
    /// Domain separator for `VINCT_COVENANT_V1`.
    pub domain: Digest32,
    /// Genesis hash of the cluster this covenant is valid on.
    pub cluster_genesis_hash: Digest32,
    /// The covenant account address.
    pub covenant: Address,
    /// The epoch this digest describes.
    pub circle_epoch: u64,
    /// The steward that convened formation.
    pub steward: Address,
    /// Commitment to the epoch's member set.
    pub member_set_hash: Digest32,
    /// Commitment to the epoch's policy set.
    pub policies_hash: Digest32,
    /// Commitment to the epoch's adapter set.
    pub adapter_set_hash: Digest32,
    /// First slot at which this epoch is valid.
    pub valid_from_slot: u64,
    /// Slot at which this epoch expires.
    pub expires_at_slot: u64,
}

impl CovenantDigestV1 {
    /// Builds a covenant digest with its domain separator already set.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cluster_genesis_hash: Digest32,
        covenant: Address,
        circle_epoch: u64,
        steward: Address,
        member_set_hash: Digest32,
        policies_hash: Digest32,
        adapter_set_hash: Digest32,
        valid_from_slot: u64,
        expires_at_slot: u64,
    ) -> Self {
        Self {
            domain: domain(domains::COVENANT_V1),
            cluster_genesis_hash,
            covenant,
            circle_epoch,
            steward,
            member_set_hash,
            policies_hash,
            adapter_set_hash,
            valid_from_slot,
            expires_at_slot,
        }
    }

    /// The digest the ratification authorities sign.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }
}

/// Commitment to the set of adapter capabilities armed for an epoch.
///
/// Ordered by capability address so the commitment is independent of the order in which
/// protocols happened to arm.
pub fn adapter_set_hash(capabilities: &[(Address, u16)]) -> Digest32 {
    let mut ordered = capabilities.to_vec();
    ordered.sort();
    let digests: Vec<Digest32> = ordered
        .iter()
        .map(|(capability, version)| {
            let mut buffer = [0u8; 34];
            buffer[..32].copy_from_slice(capability.as_bytes());
            buffer[32..].copy_from_slice(&version.to_le_bytes());
            crate::hash::sha256(&buffer)
        })
        .collect();
    hash_digest_list(&domain(domains::ADAPTER_SET_V1), &digests)
}

//! Sealed attestations.
//!
//! An attestation is a member's decision on one incident version. It lives in the
//! private incident account inside the PER and is zeroized before that account ever
//! commits. What survives to the base layer is an aggregate count, never a per-member
//! decision.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::address::Address;
use crate::domains;
use crate::error::VinctTypesError;
use crate::hash::{domain, hash_borsh, Digest32};

/// A member's decision.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Decision {
    /// Counts toward the approval threshold.
    Approve,
    /// Counts toward the rejection ceiling.
    Reject,
    /// Counts toward neither. Recorded so a member can go on record as having responded
    /// without moving the outcome in either direction.
    Abstain,
}

/// The lifecycle of one member's attestation on one incident.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationState {
    /// The member's current effective decision.
    Submitted,
    /// Replaced by a later submission from the same member before certification.
    Superseded,
    /// Invalidated because the member was quarantined mid-incident.
    InvalidatedByQuarantine,
}

/// One sealed attestation.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttestationV1 {
    /// Domain separator for `VINCT_ATTESTATION_V1`.
    pub domain: Digest32,
    /// The covenant.
    pub covenant: Address,
    /// The frozen epoch.
    pub circle_epoch: u64,
    /// The incident this attestation is bound to.
    pub incident_id: u64,
    /// The attesting member.
    pub member: Address,
    /// The decision.
    pub decision: Decision,
    /// Per-member monotonic nonce. A resubmission must strictly increase it.
    pub submission_nonce: u64,
    /// Slot the attestation was accepted at.
    pub submitted_at_slot: u64,
    /// Current state.
    pub state: AttestationState,
}

impl AttestationV1 {
    /// Builds a freshly submitted attestation.
    pub fn new(
        covenant: Address,
        circle_epoch: u64,
        incident_id: u64,
        member: Address,
        decision: Decision,
        submission_nonce: u64,
        submitted_at_slot: u64,
    ) -> Self {
        Self {
            domain: domain(domains::ATTESTATION_V1),
            covenant,
            circle_epoch,
            incident_id,
            member,
            decision,
            submission_nonce,
            submitted_at_slot,
            state: AttestationState::Submitted,
        }
    }

    /// This attestation's digest.
    ///
    /// Used for the hash-linked audit record held inside the private state until terminal
    /// zeroization. It is never published, because publishing it would reveal how a named
    /// member voted.
    pub fn digest(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }

    /// True when this attestation is the member's current effective decision.
    pub fn is_effective(&self) -> bool {
        matches!(self.state, AttestationState::Submitted)
    }

    /// True when this attestation belongs to the given incident version.
    ///
    /// Checked on every submission. A certificate or attestation from one incident must
    /// never satisfy another, and an attestation from a superseded epoch must never
    /// satisfy an incident frozen at a later one.
    pub fn matches_incident(
        &self,
        covenant: &Address,
        circle_epoch: u64,
        incident_id: u64,
    ) -> bool {
        &self.covenant == covenant
            && self.circle_epoch == circle_epoch
            && self.incident_id == incident_id
    }
}

//! Governed recovery.
//!
//! A recovery never reuses the original operation's identity. It gets a fresh operation
//! ID derived from a new recovery nonce, so an adapter that already consumed the original
//! operation will still refuse it, and an adapter that has not will accept exactly one of
//! the two. That is what makes a retry safe without a distributed lock.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::address::Address;
use crate::domains;
use crate::error::VinctTypesError;
use crate::hash::{domain, hash_borsh, sha256, Digest32};

/// Where a recovery proposal sits.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryStatus {
    /// Created, awaiting the required human approvals.
    Proposed,
    /// Approved and eligible to schedule.
    Approved,
    /// Scheduled through a new intent.
    Scheduled,
    /// Every effect the original was missing has now been observed.
    Completed,
    /// The recovery window closed without completion.
    Expired,
    /// Withdrawn by the approving authorities.
    Abandoned,
}

/// Why a recovery proposal was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryRefusal {
    /// The original operation's classification does not permit recovery.
    ClassificationBlocksRecovery,
    /// The proposal reuses the original operation ID.
    ReusedOperationId,
    /// The proposal reuses the original certificate nonce.
    ReusedCertificateNonce,
    /// The proposal names effects the original did not require.
    MissingEffectNotInOriginal,
    /// The proposal names no missing effects, so there is nothing to recover.
    NothingToRecover,
    /// The recovery window has already closed.
    Expired,
    /// The proposal broadens the original bounded action category.
    CategoryBroadened,
    /// A recovery for this original operation already exists.
    DuplicateRecovery,
}

/// A governed recovery operation.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecoveryOperationV1 {
    /// Domain separator for `VINCT_RECOVERY_V1`.
    pub domain: Digest32,
    /// The operation this recovery follows. Immutable and never overwritten.
    pub original_operation_id: Digest32,
    /// The original certificate's hash, retained as evidence.
    pub original_certificate_hash: Digest32,
    /// The covenant.
    pub covenant: Address,
    /// The frozen epoch.
    pub circle_epoch: u64,
    /// The incident.
    pub incident_id: u64,
    /// Action indices whose effects were positively established as missing.
    pub missing_action_indices: Vec<u16>,
    /// The fresh nonce this recovery draws.
    pub recovery_nonce: u64,
    /// The recovery's own operation ID.
    pub recovery_operation_id: Digest32,
    /// Slot after which the recovery may no longer be attempted.
    pub expires_at_slot: u64,
    /// Approvals required before scheduling.
    pub required_approvals: u8,
    /// Approvals collected so far.
    pub approval_count: u8,
    /// Current status.
    pub status: RecoveryStatus,
}

impl RecoveryOperationV1 {
    /// This recovery's digest.
    pub fn hash(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }
}

/// Derives a recovery's operation ID.
///
/// Domain-separated from the ordinary operation ID so a recovery identity can never
/// collide with a primary one even if every other input happened to match.
pub fn recovery_operation_id(
    original_operation_id: &Digest32,
    covenant: &Address,
    circle_epoch: u64,
    incident_id: u64,
    recovery_nonce: u64,
) -> Digest32 {
    let mut preimage = Vec::with_capacity(32 * 3 + 8 * 3);
    preimage.extend_from_slice(&domain(domains::RECOVERY_V1));
    preimage.extend_from_slice(original_operation_id);
    preimage.extend_from_slice(covenant.as_bytes());
    preimage.extend_from_slice(&circle_epoch.to_le_bytes());
    preimage.extend_from_slice(&incident_id.to_le_bytes());
    preimage.extend_from_slice(&recovery_nonce.to_le_bytes());
    sha256(&preimage)
}

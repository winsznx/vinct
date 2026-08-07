//! Incident lifecycle, private claim, and the frozen snapshot.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::address::Address;
use crate::domains;
use crate::error::VinctTypesError;
use crate::hash::{domain, hash_borsh, Digest32};
use crate::policy::{ActionCategory, DependencyNamespace};

/// Where an incident sits in its lifecycle.
///
/// Mirrors PRD section 11.2. The three states after `Settling` are not error codes; they
/// are the honest outcomes of a delivery model where a scheduling signature does not
/// prove an action ran.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum IncidentStatus {
    /// Account initialised on base, not yet opened.
    Draft,
    /// Opened inside the PER, snapshot frozen.
    Open,
    /// Accepting sealed attestations.
    Collecting,
    /// Threshold met, private fields scrubbed, certificate issued, not yet scheduled.
    CertifiedPendingSettlement,
    /// Intent accepted by the ER. Nothing about base-layer delivery is known yet.
    Settling,
    /// Every required adapter receipt, target effect, and the settlement receipt observed.
    Settled,
    /// The scrubbed checkpoint committed but no required action effect was observed.
    CommitWithoutActions,
    /// Observations conflict or the cohort is incomplete. Needs a human.
    ReconciliationRequired,
    /// Provider or RPC evidence is insufficient. Execution status is unknown, not failed.
    SettlementUnknown,
    /// Deadline passed without reaching the threshold.
    Expired,
    /// Terminated before certification.
    Aborted,
}

impl IncidentStatus {
    /// True when no further transition is possible.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Settled | Self::Expired | Self::Aborted | Self::CommitWithoutActions
        )
    }

    /// True when the incident still accepts attestations.
    pub fn accepts_attestations(&self) -> bool {
        matches!(self, Self::Open | Self::Collecting)
    }
}

/// How confident the submitter is. A bucket, not a number, so the value carries no
/// fingerprint of the submitter's private model.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ConfidenceBucket {
    /// Weak signal.
    Low,
    /// Corroborated signal.
    Medium,
    /// Strong, independently corroborated signal.
    High,
}

/// The kind of anomaly observed.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SignalCategory {
    /// A price feed stopped updating or moved implausibly.
    OracleDeviation,
    /// A dependency stopped responding.
    DependencyUnavailable,
    /// An upgrade or authority change nobody expected.
    UnexpectedAuthorityChange,
    /// Balances or supply moved in a way the protocol cannot explain.
    UnexplainedOutflow,
}

/// The private incident claim.
///
/// Mirrors PRD section 17. This structure never reaches the base layer: only its digest
/// is committed, and the buffer holding it is zeroized before any commit.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct IncidentClaimV1 {
    /// Domain separator for `VINCT_INCIDENT_CLAIM_V1`.
    pub domain: Digest32,
    /// Namespace of the covered dependency.
    pub dependency_namespace: DependencyNamespace,
    /// Identity of the covered dependency.
    pub dependency_id: Digest32,
    /// Start of the observation window, as a unix timestamp.
    pub observation_window_start: i64,
    /// End of the observation window, as a unix timestamp.
    pub observation_window_end: i64,
    /// Commitment to the schema the evidence follows.
    pub claim_schema_hash: Digest32,
    /// Commitment to the evidence itself. The evidence never leaves the responder.
    pub private_evidence_digest: Digest32,
    /// The kind of anomaly.
    pub signal_category: SignalCategory,
    /// How strong the signal is.
    pub confidence_bucket: ConfidenceBucket,
    /// The action category the responder is asking for.
    pub requested_action_category: ActionCategory,
    /// The submitting member.
    pub submitter: Address,
    /// Per-member monotonic nonce.
    pub submission_nonce: u64,
}

impl IncidentClaimV1 {
    /// Builds a claim with its domain separator already set.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        dependency_namespace: DependencyNamespace,
        dependency_id: Digest32,
        observation_window_start: i64,
        observation_window_end: i64,
        claim_schema_hash: Digest32,
        private_evidence_digest: Digest32,
        signal_category: SignalCategory,
        confidence_bucket: ConfidenceBucket,
        requested_action_category: ActionCategory,
        submitter: Address,
        submission_nonce: u64,
    ) -> Self {
        Self {
            domain: domain(domains::INCIDENT_CLAIM_V1),
            dependency_namespace,
            dependency_id,
            observation_window_start,
            observation_window_end,
            claim_schema_hash,
            private_evidence_digest,
            signal_category,
            confidence_bucket,
            requested_action_category,
            submitter,
            submission_nonce,
        }
    }

    /// The claim digest. Safe to publish; the claim itself is not.
    pub fn digest(&self) -> Result<Digest32, VinctTypesError> {
        hash_borsh(self)
    }

    /// True when the observation window is coherent.
    pub fn window_is_valid(&self) -> bool {
        self.observation_window_start < self.observation_window_end
    }
}

/// Everything an incident freezes at the moment it opens.
///
/// VINCT never re-reads live covenant state during an incident. Membership, roles,
/// threshold, policy, template, adapter versions, and expiry are all captured here, so a
/// covenant change mid-incident cannot alter an outcome already in flight.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct IncidentSnapshotV1 {
    /// The covenant.
    pub covenant: Address,
    /// The epoch frozen at open.
    pub circle_epoch: u64,
    /// The incident.
    pub incident_id: u64,
    /// The policy frozen at open.
    pub policy_id: Digest32,
    /// The member set frozen at open.
    pub member_set_hash: Digest32,
    /// The policy's registered template, frozen at open.
    pub action_bundle_template_hash: Digest32,
    /// The cluster this incident is bound to.
    pub cluster_genesis_hash: Digest32,
    /// Slot the incident opened at.
    pub opened_at_slot: u64,
    /// Slot after which the incident expires.
    pub expires_at_slot: u64,
    /// Approvals required. Frozen, and never lowered by quarantine.
    pub required_approvals: u8,
    /// Rejections that block certification.
    pub maximum_rejections: u8,
    /// Digest of the private claim that opened the incident.
    pub claim_digest: Digest32,
}

impl IncidentSnapshotV1 {
    /// True when `now_slot` is at or past the deadline.
    pub fn is_expired(&self, now_slot: u64) -> bool {
        now_slot >= self.expires_at_slot
    }
}

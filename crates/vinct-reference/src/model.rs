//! The state the reference model reasons over.
//!
//! These are plain snapshots with no clock, no randomness, and no I/O. Every time-like
//! input is an explicit `now_slot` argument, which is what makes the model reproducible
//! and what lets production integration tests compare against it instead of
//! reimplementing expected values.

use vinct_types::action::ActionBundleTemplateV1;
use vinct_types::address::Address;
use vinct_types::attestation::{AttestationState, AttestationV1};
use vinct_types::covenant::{MemberSetV1, MemberStatus, MemberV1};
use vinct_types::hash::Digest32;
use vinct_types::incident::{IncidentSnapshotV1, IncidentStatus};
use vinct_types::policy::ResponsePolicyV1;

/// One covenant epoch, as frozen for an incident.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CovenantSnapshot {
    /// The covenant account.
    pub covenant: Address,
    /// The epoch.
    pub circle_epoch: u64,
    /// The cluster this covenant is bound to.
    pub cluster_genesis_hash: Digest32,
    /// The steward that convened formation. Holds no protocol authority.
    pub steward: Address,
    /// The epoch's member set.
    pub member_set: MemberSetV1,
    /// The policy governing this incident.
    pub policy: ResponsePolicyV1,
    /// The registered action template the policy commits to.
    pub template: ActionBundleTemplateV1,
    /// First slot the epoch is valid.
    pub valid_from_slot: u64,
    /// Slot the epoch expires.
    pub expires_at_slot: u64,
}

impl CovenantSnapshot {
    /// True when the epoch covers `now_slot`.
    pub fn is_active(&self, now_slot: u64) -> bool {
        now_slot >= self.valid_from_slot && now_slot < self.expires_at_slot
    }
}

/// One incident's mutable state.
///
/// `quarantined` lives here rather than inside [`MemberSetV1`] on purpose. Quarantine is
/// an incident-scoped decision, and folding it into the member set would change the
/// member-set hash mid-incident, breaking the very snapshot the incident froze.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncidentState {
    /// Everything frozen when the incident opened.
    pub snapshot: IncidentSnapshotV1,
    /// Current lifecycle status.
    pub status: IncidentStatus,
    /// Members quarantined during this incident, in the order they were quarantined.
    pub quarantined: Vec<Address>,
    /// Every attestation ever accepted, including superseded and invalidated ones.
    ///
    /// The full history is retained inside the private state so a member can prove what
    /// they submitted. It is zeroized before the account commits, so none of it reaches
    /// the base layer.
    pub attestations: Vec<AttestationV1>,
}

impl IncidentState {
    /// A freshly opened incident.
    pub fn open(snapshot: IncidentSnapshotV1) -> Self {
        Self {
            snapshot,
            status: IncidentStatus::Collecting,
            quarantined: Vec::new(),
            attestations: Vec::new(),
        }
    }

    /// This member's current effective attestation, if any.
    ///
    /// Only a `Submitted` record is effective. A superseded or quarantine-invalidated
    /// record is not, so it can never contribute an approval.
    pub fn effective_attestation(&self, member: &Address) -> Option<&AttestationV1> {
        self.attestations
            .iter()
            .find(|a| &a.member == member && a.is_effective())
    }

    /// This member's binding attestation: the one that still carries weight.
    ///
    /// Wider than [`Self::effective_attestation`] by exactly one case. A record
    /// invalidated by quarantine still binds, because a rejection cast while the member
    /// was trusted must keep counting toward the rejection ceiling. Quarantining a
    /// dissenter would otherwise erase their objection and unblock an action the covenant
    /// had already refused. A superseded record never binds: the member replaced it
    /// themselves, while trusted.
    ///
    /// At most one record per member can be in either state. Quarantine converts a
    /// member's single `Submitted` record and then blocks further submissions, so the two
    /// states cannot coexist for one member.
    pub fn binding_attestation(&self, member: &Address) -> Option<&AttestationV1> {
        self.attestations.iter().find(|a| {
            &a.member == member
                && matches!(
                    a.state,
                    AttestationState::Submitted | AttestationState::InvalidatedByQuarantine
                )
        })
    }

    /// The highest submission nonce this member has used, effective or not.
    ///
    /// Includes superseded and invalidated records, so a member cannot replay an old
    /// nonce after their attestation was superseded.
    pub fn highest_nonce_for(&self, member: &Address) -> Option<u64> {
        self.attestations
            .iter()
            .filter(|a| &a.member == member)
            .map(|a| a.submission_nonce)
            .max()
    }

    /// True when this member is quarantined for this incident.
    pub fn is_quarantined(&self, member: &Address) -> bool {
        self.quarantined.contains(member)
    }

    /// This member's status within this incident.
    pub fn status_of(&self, member: &Address) -> MemberStatus {
        if self.is_quarantined(member) {
            MemberStatus::Quarantined
        } else {
            MemberStatus::Active
        }
    }
}

/// Every member eligible to attest under a covenant snapshot and incident state.
///
/// Eligibility is the intersection of three things: present in the frozen member set,
/// holding a role the policy permits, and not quarantined for this incident.
pub fn eligible_members<'a>(
    covenant: &'a CovenantSnapshot,
    incident: &IncidentState,
) -> Vec<&'a MemberV1> {
    covenant
        .member_set
        .members
        .iter()
        .filter(|member| covenant.policy.role_may_attest(member.role))
        .filter(|member| !incident.is_quarantined(&member.member))
        .collect()
}

/// Every member whose rejection still counts, quarantined or not.
///
/// The rejection ceiling is evaluated over this wider set. See
/// [`IncidentState::binding_attestation`].
pub fn objecting_members(covenant: &CovenantSnapshot) -> Vec<&MemberV1> {
    covenant
        .member_set
        .members
        .iter()
        .filter(|member| covenant.policy.role_may_attest(member.role))
        .collect()
}

/// Marks an attestation record as superseded.
pub fn supersede(attestation: &mut AttestationV1) {
    attestation.state = AttestationState::Superseded;
}

/// Marks an attestation record as invalidated by quarantine.
pub fn invalidate_by_quarantine(attestation: &mut AttestationV1) {
    attestation.state = AttestationState::InvalidatedByQuarantine;
}

//! Incident evaluation.
//!
//! One function decides whether a covenant has certified. Everything else in VINCT reads
//! its answer: the on-chain program, the settlement monitor, the verifier, and the tests.
//! There is no second implementation of the expected value anywhere.

use vinct_types::address::Address;
use vinct_types::attestation::{AttestationV1, Decision};
use vinct_types::incident::IncidentStatus;

use crate::model::{eligible_members, objecting_members, CovenantSnapshot, IncidentState};

/// Why a submission or evaluation was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationError {
    /// The member set does not contain this member.
    NotAMember,
    /// The member's role is not permitted to attest under this policy.
    RoleMayNotAttest,
    /// The member is quarantined for this incident.
    MemberQuarantined,
    /// The attestation names a different covenant, epoch, or incident.
    IncidentMismatch,
    /// The submission nonce did not strictly increase.
    NonceNotIncreasing,
    /// The incident is no longer accepting attestations.
    IncidentNotCollecting,
    /// The incident deadline has passed.
    IncidentExpired,
    /// The covenant epoch is not active at this slot.
    EpochNotActive,
    /// The covenant snapshot is for a different epoch than the incident froze.
    StaleEpoch,
    /// The covenant snapshot's member set is not the one the incident froze.
    MemberSetMismatch,
    /// The covenant snapshot's policy is not the one the incident froze.
    PolicyMismatch,
    /// The covenant snapshot's template is not the one the incident froze.
    TemplateMismatch,
    /// The frozen threshold is zero.
    ZeroThreshold,
    /// A canonical type rejected the input.
    Types(vinct_types::VinctTypesError),
}

/// The private tally.
///
/// Never published while an incident is live. The exact live approval and rejection
/// counts are exactly what an attacker needs to know whether coercing one more member
/// would flip an outcome, so [`PublicIncidentView`] carries none of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tally {
    /// Members eligible to attest right now.
    pub eligible: u8,
    /// Effective approvals.
    pub approvals: u8,
    /// Rejections that still bind, including those from quarantined members.
    ///
    /// Can exceed [`Tally::eligible`] when members were quarantined after objecting.
    pub rejections: u8,
    /// Effective abstentions.
    pub abstentions: u8,
    /// Members quarantined for this incident.
    pub quarantined: u8,
    /// Eligible members who have not yet submitted an effective attestation.
    pub outstanding: u8,
}

impl Tally {
    /// The largest approval count still reachable.
    ///
    /// Every outstanding eligible member could still approve. Members who already
    /// rejected or abstained cannot be counted again, because one member contributes at
    /// most one effective decision.
    pub fn max_reachable_approvals(&self) -> u8 {
        self.approvals.saturating_add(self.outstanding)
    }
}

/// What the covenant has decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationOutcome {
    /// Still collecting and the threshold is still reachable.
    Collecting,
    /// The threshold is met. A certificate may be issued.
    Certified,
    /// The rejection ceiling was reached. No certificate will be issued.
    RejectedByThreshold,
    /// The deadline passed without reaching the threshold.
    Expired,
    /// The threshold can no longer be reached, but the deadline has not passed.
    ///
    /// Reached when quarantine or rejections leave too few outstanding members. The
    /// incident stays open until it expires so a human can see why it failed rather than
    /// finding it silently gone.
    Impossible,
}

/// The result of evaluating an incident.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvaluationResult {
    /// The decision.
    pub outcome: EvaluationOutcome,
    /// The private tally behind it.
    pub tally: Tally,
}

/// Everything an unauthorised observer is allowed to learn.
///
/// No counts, no member identities, no decisions. An observer learns that an incident
/// exists, which action category it concerns, and when it closes. Hiding existence is
/// explicitly not claimed: the covenant and its policies are public, and an incident
/// account's creation is visible on base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicIncidentView {
    /// The incident.
    pub incident_id: u64,
    /// Lifecycle status only.
    pub status: IncidentStatus,
    /// The deadline.
    pub expires_at_slot: u64,
    /// Whether the incident has reached a terminal state.
    pub is_terminal: bool,
}

/// Reduces an evaluation to the observer-safe view.
pub fn public_view(
    incident: &IncidentState,
    result: &EvaluationResult,
    now_slot: u64,
) -> PublicIncidentView {
    let status = match result.outcome {
        EvaluationOutcome::Certified => IncidentStatus::CertifiedPendingSettlement,
        EvaluationOutcome::Expired => IncidentStatus::Expired,
        _ if incident.snapshot.is_expired(now_slot) => IncidentStatus::Expired,
        _ => incident.status,
    };
    PublicIncidentView {
        incident_id: incident.snapshot.incident_id,
        status,
        expires_at_slot: incident.snapshot.expires_at_slot,
        is_terminal: status.is_terminal(),
    }
}

/// Checks that a covenant snapshot is the one this incident froze.
///
/// Every incident carries commitments to the membership, policy, and template it opened
/// under. Re-deriving them from the supplied snapshot and comparing is what stops a
/// superseded epoch, an edited policy, or a swapped template from deciding an incident
/// that was opened under different terms.
pub fn check_snapshot_binding(
    covenant: &CovenantSnapshot,
    incident: &IncidentState,
) -> Result<(), EvaluationError> {
    if covenant.circle_epoch != incident.snapshot.circle_epoch {
        return Err(EvaluationError::StaleEpoch);
    }
    if covenant.covenant != incident.snapshot.covenant {
        return Err(EvaluationError::IncidentMismatch);
    }
    if covenant.cluster_genesis_hash != incident.snapshot.cluster_genesis_hash {
        return Err(EvaluationError::IncidentMismatch);
    }
    let member_set_hash = covenant.member_set.hash().map_err(EvaluationError::Types)?;
    if member_set_hash != incident.snapshot.member_set_hash {
        return Err(EvaluationError::MemberSetMismatch);
    }
    if covenant.policy.policy_id != incident.snapshot.policy_id {
        return Err(EvaluationError::PolicyMismatch);
    }
    let template_hash = covenant.template.hash().map_err(EvaluationError::Types)?;
    if template_hash != incident.snapshot.action_bundle_template_hash {
        return Err(EvaluationError::TemplateMismatch);
    }
    if covenant.policy.action_bundle_template_hash != template_hash {
        return Err(EvaluationError::TemplateMismatch);
    }
    if incident.snapshot.required_approvals == 0 {
        return Err(EvaluationError::ZeroThreshold);
    }
    Ok(())
}

/// Validates and applies one attestation submission.
///
/// On success the incident's attestation history gains the new record and the member's
/// previous effective record, if any, is marked superseded. A member therefore always has
/// at most one effective decision, and the audit trail of what they submitted survives
/// inside the private state until terminal zeroization.
pub fn submit_attestation(
    covenant: &CovenantSnapshot,
    incident: &mut IncidentState,
    attestation: AttestationV1,
    now_slot: u64,
) -> Result<(), EvaluationError> {
    check_snapshot_binding(covenant, incident)?;

    if !incident.status.accepts_attestations() {
        return Err(EvaluationError::IncidentNotCollecting);
    }
    if incident.snapshot.is_expired(now_slot) {
        return Err(EvaluationError::IncidentExpired);
    }
    if !covenant.is_active(now_slot) {
        return Err(EvaluationError::EpochNotActive);
    }
    if !attestation.matches_incident(
        &incident.snapshot.covenant,
        incident.snapshot.circle_epoch,
        incident.snapshot.incident_id,
    ) {
        return Err(EvaluationError::IncidentMismatch);
    }

    let member = covenant
        .member_set
        .find(&attestation.member)
        .ok_or(EvaluationError::NotAMember)?;
    if !covenant.policy.role_may_attest(member.role) {
        return Err(EvaluationError::RoleMayNotAttest);
    }
    if incident.is_quarantined(&attestation.member) {
        return Err(EvaluationError::MemberQuarantined);
    }

    // Strictly increasing, and compared against every nonce the member has ever used
    // rather than only their current effective one. Otherwise a member whose attestation
    // was superseded could replay the superseded nonce and resurrect an old decision.
    if let Some(highest) = incident.highest_nonce_for(&attestation.member) {
        if attestation.submission_nonce <= highest {
            return Err(EvaluationError::NonceNotIncreasing);
        }
    }

    for existing in incident.attestations.iter_mut() {
        if existing.member == attestation.member && existing.is_effective() {
            crate::model::supersede(existing);
        }
    }
    incident.attestations.push(attestation);
    Ok(())
}

/// Quarantines a member for one incident.
///
/// Invalidates that member's current attestation and stops them submitting another. It
/// never lowers `required_approvals`: a suspected compromise must make certification
/// harder, never easier. If quarantine leaves too few members to reach the threshold, the
/// incident becomes [`EvaluationOutcome::Impossible`] and expires.
pub fn quarantine_member(
    covenant: &CovenantSnapshot,
    incident: &mut IncidentState,
    member: Address,
) -> Result<(), EvaluationError> {
    check_snapshot_binding(covenant, incident)?;
    if covenant.member_set.find(&member).is_none() {
        return Err(EvaluationError::NotAMember);
    }
    if incident.is_quarantined(&member) {
        return Ok(());
    }
    for existing in incident.attestations.iter_mut() {
        if existing.member == member && existing.is_effective() {
            crate::model::invalidate_by_quarantine(existing);
        }
    }
    incident.quarantined.push(member);
    Ok(())
}

/// Evaluates an incident against its frozen policy.
///
/// Mirrors PRD section 22's `evaluate_incident`. Time enters only through `now_slot`.
pub fn evaluate_incident(
    covenant: &CovenantSnapshot,
    incident: &IncidentState,
    now_slot: u64,
) -> Result<EvaluationResult, EvaluationError> {
    check_snapshot_binding(covenant, incident)?;

    let eligible = eligible_members(covenant, incident);
    let eligible_count = u8::try_from(eligible.len()).unwrap_or(u8::MAX);

    let mut approvals: u8 = 0;
    let mut abstentions: u8 = 0;
    let mut responded: u8 = 0;

    // Approvals and abstentions come only from members who are still eligible. A
    // quarantined member's approval is discarded: a possibly-compromised key must not be
    // able to authorise an action.
    for member in &eligible {
        let Some(attestation) = incident.effective_attestation(&member.member) else {
            continue;
        };
        responded = responded.saturating_add(1);
        match attestation.decision {
            Decision::Approve => approvals = approvals.saturating_add(1),
            Decision::Abstain => abstentions = abstentions.saturating_add(1),
            // Counted separately below, over the wider objecting set.
            Decision::Reject => {}
        }
    }

    // Rejections are counted over every role-permitted member, quarantined or not.
    //
    // Discarding a quarantined member's rejection would let whoever holds the quarantine
    // authority erase objections until the ceiling stopped blocking, and push through an
    // action the covenant had already refused. PRD section 21 requires that quarantine
    // cannot certify an incident, and PRD section 16 requires that a suspected compromise
    // never makes automatic execution easier. Keeping the objection is the only direction
    // that satisfies both. See docs/decision-log.md entry D-0013.
    let mut rejections: u8 = 0;
    for member in objecting_members(covenant) {
        let Some(attestation) = incident.binding_attestation(&member.member) else {
            continue;
        };
        if attestation.decision == Decision::Reject {
            rejections = rejections.saturating_add(1);
        }
    }

    let quarantined = u8::try_from(incident.quarantined.len()).unwrap_or(u8::MAX);
    let tally = Tally {
        eligible: eligible_count,
        approvals,
        rejections,
        abstentions,
        quarantined,
        outstanding: eligible_count.saturating_sub(responded),
    };

    let required = incident.snapshot.required_approvals;
    let max_rejections = incident.snapshot.maximum_rejections;

    // Order matters. A rejection ceiling that has already been breached is a decided
    // outcome even if approvals would otherwise meet the threshold in the same block,
    // because the covenant agreed that enough objections stop the action.
    let outcome = if rejections > max_rejections {
        EvaluationOutcome::RejectedByThreshold
    } else if approvals >= required {
        EvaluationOutcome::Certified
    } else if incident.snapshot.is_expired(now_slot) {
        EvaluationOutcome::Expired
    } else if tally.max_reachable_approvals() < required {
        EvaluationOutcome::Impossible
    } else {
        EvaluationOutcome::Collecting
    };

    Ok(EvaluationResult { outcome, tally })
}

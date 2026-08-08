//! The private incident lifecycle.
//!
//! Three account classes, and the split between them is the whole design.
//!
//! [`IncidentCore`] is public and never permissioned. It carries what an observer is
//! entitled to know: that an incident is open, under which covenant and policy, and when it
//! closes. It holds no evidence, no decision, and no running tally, so there is nothing in
//! it worth hiding.
//!
//! [`IncidentClaim`] is private to the incident's member set. The responder's raw claim and
//! notes live here because every member needs them to decide. This is shared context, not a
//! per-member secret.
//!
//! [`MemberAttestation`] is one account per member, private to that member alone. Nobody
//! else can read it. Not the opener, not the other members, not the wallet that paid for it.
//!
//! No account anywhere holds a live tally. There is no counter to read, because the program
//! never keeps one: certification is passed every attestation account at once and counts
//! them in memory. What cannot be stored cannot leak.
//!
//! This works because of a property of private ephemeral rollups that took an experiment to
//! establish: a permission gates *reading* an account, not touching it. A member submits a
//! transaction that writes their own attestation, and the program reads every other
//! attestation in the same instruction, and that member still cannot read any of them. See
//! `docs/decision-log.md` D-0042 and
//! `artifacts/devnet/per-visibility-experiment-latest.json`.
//!
//! Two rules shape every instruction here. Nothing that can commit or undelegate may run
//! while a protected field still holds non-zero bytes, and the check is on the bytes rather
//! than on a flag. And nothing readable from outside a permission may reveal quorum
//! progress, which is now true by construction rather than by care.

use anchor_lang::prelude::*;

use crate::{CoreError, IncidentCertificate, CERTIFICATE_SEED};

/// Seed for the public incident core.
pub const INCIDENT_SEED: &[u8] = b"incident";
/// Seed for the private claim.
pub const CLAIM_SEED: &[u8] = b"incident-claim";
/// Seed for one member's private attestation.
pub const ATTESTATION_SEED: &[u8] = b"incident-attestation";

/// Schema version for the private incident account family.
///
/// One number for all three account classes, because they are created together, delegated
/// together, and read together. A ballot that predates a layout change must not be counted
/// under the new one, so certification refuses anything that is not current rather than
/// trying to interpret it.
pub const INCIDENT_SCHEMA_VERSION: u16 = 1;

/// Domain separator for the frozen member-set commitment.
pub const MEMBER_SET_DOMAIN: &[u8] = b"vinct:incident-member-set:v1";

/// Maximum members one incident can hold.
///
/// Bounds the account list `certify_incident` has to accept in one transaction, which is the
/// real constraint: every attestation is passed in at once.
pub const MAX_INCIDENT_MEMBERS: usize = 8;

/// Maximum bytes in the private claim payload.
pub const MAX_PRIVATE_CLAIM: usize = 256;

/// Maximum bytes in the private responder notes.
pub const MAX_PRIVATE_NOTES: usize = 128;

/// A member's decision. Mirrors `vinct_types::attestation::Decision`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Decision {
    /// No decision recorded.
    #[default]
    None,
    /// Counts toward the approval threshold.
    Approve,
    /// Counts toward the rejection ceiling.
    Reject,
    /// Counts toward neither.
    Abstain,
}

/// Where an incident sits. Mirrors `vinct_types::incident::IncidentStatus`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum IncidentStatus {
    /// Created on base, not yet opened.
    #[default]
    Draft,
    /// Open inside the PER, accepting attestations.
    Collecting,
    /// Threshold met. Private accounts still need scrubbing before they can leave.
    CertifiedPendingSettlement,
    /// Deadline passed without reaching the threshold.
    Expired,
    /// The rejection ceiling was breached.
    ///
    /// Only ever recorded at or after the deadline, never the moment the blocking rejection
    /// lands. Terminating early would tell a watcher exactly when that happened. Waiting
    /// costs nothing, because the incident could not have certified either way.
    RejectedByThreshold,
    /// Terminated before certification.
    Aborted,
}

impl IncidentStatus {
    /// True once no further attestation can change the outcome.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            IncidentStatus::CertifiedPendingSettlement
                | IncidentStatus::Expired
                | IncidentStatus::RejectedByThreshold
                | IncidentStatus::Aborted
        )
    }
}

/// The public face of an incident.
///
/// Deliberately holds nothing worth hiding. Every field here is either policy an observer
/// could look up anyway, or an aggregate that only exists after the outcome is settled.
#[account]
pub struct IncidentCore {
    /// Schema version. Checked wherever this account is read by hand.
    pub version: u16,
    /// The covenant.
    pub covenant: Pubkey,
    /// The epoch frozen at open.
    pub circle_epoch: u64,
    /// The incident.
    pub incident_id: u64,
    /// The responder that opened it.
    pub opener: Pubkey,
    /// Lifecycle status.
    pub status: IncidentStatus,
    /// The policy frozen at open.
    pub policy_id: [u8; 32],
    /// The member set frozen at open.
    pub member_set_hash: [u8; 32],
    /// The cluster this incident is bound to.
    pub cluster_genesis_hash: [u8; 32],
    /// Approvals required. Never lowered by quarantine.
    pub required_approvals: u8,
    /// Rejections that block certification.
    pub maximum_rejections: u8,
    /// Slot the incident opened.
    pub opened_at_slot: u64,
    /// Slot the incident expires.
    pub expires_at_slot: u64,
    /// The response window copied from the covenant, so opening needs no argument for it.
    pub response_window_slots: u64,
    /// The action template the covenant's policy commits to, copied at creation.
    pub action_bundle_template_hash: [u8; 32],
    /// Digest of the private claim. Safe to publish; the claim itself is not.
    pub claim_digest: [u8; 32],
    /// The operation this incident settles under, derived at certification.
    pub operation_id: [u8; 32],
    /// Slot the outcome was settled. Zero until certification.
    pub certified_at_slot: u64,
    /// How long the certificate this incident produces remains usable.
    pub certificate_lifetime_slots: u64,
    /// How many member attestation accounts exist for this incident.
    ///
    /// Public because certification has to be handed exactly this many accounts, and a
    /// caller cannot assemble them without knowing the count. It reveals the size of the
    /// circle, which the frozen member set hash already commits to.
    pub member_count: u8,
    /// Aggregate approvals, written only at certification.
    pub approval_count_after_terminal: u8,
    /// Aggregate rejections, written only at certification.
    pub rejection_count_after_terminal: u8,
    /// PDA bump.
    pub bump: u8,
}

impl IncidentCore {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 2
        + 32
        + 8
        + 8
        + 32
        + 1
        + 32
        + 32
        + 32
        + 1
        + 1
        + 8
        + 8
        + 8
        + 32
        + 32
        + 32
        + 8
        + 8
        + 1
        + 1
        + 1
        + 1;

    /// True when `now_slot` is at or past the deadline.
    pub fn is_expired(&self, now_slot: u64) -> bool {
        now_slot >= self.expires_at_slot
    }
}

/// The responder's evidence, private to the incident's members.
#[account]
pub struct IncidentClaim {
    /// Schema version.
    pub version: u16,
    /// The incident this belongs to.
    pub incident: Pubkey,
    /// The responder that may write it.
    pub opener: Pubkey,

    // ---- protected while active, zeroized before any commit ----
    /// The raw private claim.
    pub private_claim: [u8; MAX_PRIVATE_CLAIM],
    /// Length of the live claim bytes.
    pub private_claim_len: u16,
    /// Free-form private responder notes.
    pub private_notes: [u8; MAX_PRIVATE_NOTES],
    /// Length of the live notes bytes.
    pub private_notes_len: u16,
    /// The responder's private observation window.
    pub private_observation_start: i64,
    /// The responder's private observation window.
    pub private_observation_end: i64,

    /// Whether the scrub has run. Never trusted on its own.
    pub private_fields_zeroized: bool,
    /// PDA bump.
    pub bump: u8,
}

impl IncidentClaim {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize =
        2 + 32 + 32 + MAX_PRIVATE_CLAIM + 2 + MAX_PRIVATE_NOTES + 2 + 8 + 8 + 1 + 1;

    /// True when every protected field is provably all-zero.
    ///
    /// Reads the bytes rather than the flag. That ordering is the whole point: a program
    /// that sets the flag first must still be caught by this.
    pub fn protected_fields_are_zero(&self) -> bool {
        self.private_claim.iter().all(|byte| *byte == 0)
            && self.private_claim_len == 0
            && self.private_notes.iter().all(|byte| *byte == 0)
            && self.private_notes_len == 0
            && self.private_observation_start == 0
            && self.private_observation_end == 0
    }

    /// The gate every commit and undelegation path must pass.
    pub fn may_leave_the_private_runtime(&self) -> Result<()> {
        require!(
            self.protected_fields_are_zero(),
            CoreError::PrivateFieldsNotZeroized
        );
        require!(
            self.private_fields_zeroized,
            CoreError::ZeroizationFlagNotSet
        );
        Ok(())
    }

    /// Overwrites every protected field.
    pub fn scrub(&mut self) {
        self.private_claim = [0u8; MAX_PRIVATE_CLAIM];
        self.private_claim_len = 0;
        self.private_notes = [0u8; MAX_PRIVATE_NOTES];
        self.private_notes_len = 0;
        self.private_observation_start = 0;
        self.private_observation_end = 0;
        self.private_fields_zeroized = true;
    }
}

/// One member's sealed decision, private to that member alone.
///
/// Created for every member when the incident opens, so the existence of an account says
/// nothing about whether that member has responded. Whether they have, and how, is inside,
/// and nobody but that member can read it.
#[account]
pub struct MemberAttestation {
    /// Schema version.
    pub version: u16,
    /// The incident this belongs to.
    pub incident: Pubkey,
    /// The member this slot belongs to.
    pub member: Pubkey,
    /// The responder that opened the incident.
    ///
    /// Copied here so delegation can check who is asking without reading the core. By the
    /// time this account is delegated the core already is, which means the core is owned by
    /// the delegation program and can no longer be deserialized as ours.
    pub opener: Pubkey,
    /// Where this ballot sits. Certification refuses any state it does not recognise.
    ///
    /// Quarantine is written by the opener, who cannot read this account. A permission gates
    /// reading, not touching. See docs/decision-log.md D-0042.
    pub state: BallotState,

    // ---- protected while active, zeroized before any commit ----
    /// The member's current decision.
    pub decision: Decision,
    /// Highest submission nonce this member has used.
    pub submission_nonce: u64,
    /// Slot of the current submission.
    pub submitted_at_slot: u64,
    /// Whether the slot holds a live decision.
    pub has_decision: bool,

    /// Whether the scrub has run. Never trusted on its own.
    pub private_fields_zeroized: bool,
    /// PDA bump.
    pub bump: u8,
}

impl MemberAttestation {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 2 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 1;

    /// True when every protected field is provably all-zero.
    pub fn protected_fields_are_zero(&self) -> bool {
        !self.has_decision
            && self.decision == Decision::None
            && self.submission_nonce == 0
            && self.submitted_at_slot == 0
    }

    /// The gate every commit and undelegation path must pass.
    pub fn may_leave_the_private_runtime(&self) -> Result<()> {
        require!(
            self.protected_fields_are_zero(),
            CoreError::PrivateFieldsNotZeroized
        );
        require!(
            self.private_fields_zeroized,
            CoreError::ZeroizationFlagNotSet
        );
        Ok(())
    }

    /// Overwrites every protected field.
    ///
    /// The state survives as `Scrubbed`, which is not the member's secret. The decision it
    /// held does not survive.
    pub fn scrub(&mut self) {
        self.decision = Decision::None;
        self.submission_nonce = 0;
        self.submitted_at_slot = 0;
        self.has_decision = false;
        self.state = BallotState::Scrubbed;
        self.private_fields_zeroized = true;
    }

    /// How this attestation counts toward the outcome.
    ///
    /// Asymmetric on purpose. Quarantine discards an approval, because a possibly-compromised
    /// key must not authorise an action. It keeps a rejection, because erasing one would let
    /// the quarantine authority unblock an action the covenant had refused. See
    /// docs/decision-log.md D-0013.
    pub fn counts_as(&self) -> Decision {
        if !self.has_decision {
            return Decision::None;
        }
        match (self.decision, self.state) {
            (Decision::Approve, BallotState::Quarantined) => Decision::None,
            (decision, _) => decision,
        }
    }

    /// True when this member is quarantined for this incident.
    pub fn is_quarantined(&self) -> bool {
        self.state == BallotState::Quarantined
    }
}

/// Commits to the exact set of members eligible to attest on an incident.
///
/// Ascending, strictly, with no repeats. The ordering is not cosmetic: it is what makes the
/// commitment a function of the *set* rather than of one presentation of it, so a caller
/// cannot reorder a supplied ballot list into a different digest. An out-of-order list is
/// rejected rather than sorted, which is the same rule the covenant member set follows.
pub fn member_set_commitment(members: &[Pubkey]) -> Result<[u8; 32]> {
    require!(
        members.len() <= MAX_INCIDENT_MEMBERS,
        CoreError::TooManyPermissionMembers
    );
    require!(!members.is_empty(), CoreError::PermissionNeedsAMember);
    for window in members.windows(2) {
        require!(
            window[0].to_bytes() < window[1].to_bytes(),
            CoreError::MemberSetNotAscending
        );
    }

    let mut preimage = Vec::with_capacity(MEMBER_SET_DOMAIN.len() + 4 + members.len() * 32);
    preimage.extend_from_slice(MEMBER_SET_DOMAIN);
    preimage.extend_from_slice(&(members.len() as u32).to_le_bytes());
    for member in members {
        preimage.extend_from_slice(member.as_ref());
    }
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(&preimage);
    Ok(hasher.finalize().into())
}

/// Where one ballot sits. Every supported state is named here.
///
/// Certification refuses a ballot in any state it does not recognise, rather than guessing.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum BallotState {
    /// Created and never written to. Counts as no decision.
    #[default]
    Empty,
    /// Holds this member's current decision.
    Submitted,
    /// The member was quarantined. An approval here is discarded, a rejection still counts.
    Quarantined,
    /// Scrubbed after the incident became terminal. Carries no decision.
    Scrubbed,
}

impl BallotState {
    /// True for the states a live incident can be certified from.
    ///
    /// `Scrubbed` is deliberately absent: a scrubbed ballot has had its decision erased, and
    /// counting one would silently drop a member's vote.
    pub fn may_be_counted(&self) -> bool {
        matches!(
            self,
            BallotState::Empty | BallotState::Submitted | BallotState::Quarantined
        )
    }
}

/// The result of counting every attestation at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tally {
    /// Approvals that count.
    pub approvals: u8,
    /// Rejections that count.
    pub rejections: u8,
}

impl Tally {
    /// Whether the frozen threshold is met.
    pub fn meets(&self, core: &IncidentCore) -> bool {
        self.rejections <= core.maximum_rejections && self.approvals >= core.required_approvals
    }
}

/// Counts a set of attestations.
///
/// Takes them all at once because there is nowhere to accumulate. That is the point: a
/// running total would be an account, and an account can be read.
pub fn tally(attestations: &[MemberAttestation]) -> Tally {
    let mut approvals: u8 = 0;
    let mut rejections: u8 = 0;
    for attestation in attestations {
        match attestation.counts_as() {
            Decision::Approve => approvals = approvals.saturating_add(1),
            Decision::Reject => rejections = rejections.saturating_add(1),
            _ => {}
        }
    }
    Tally {
        approvals,
        rejections,
    }
}

/// Arguments for submitting a private claim.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PrivateClaimArgs {
    /// The raw claim bytes. Held only inside the PER.
    pub claim: Vec<u8>,
    /// The responder's observation window.
    pub observation_start: i64,
    /// The responder's observation window.
    pub observation_end: i64,
    /// Free-form private notes.
    pub notes: Vec<u8>,
}

/// One member of a private account's ER-local permission.
///
/// Flags are explicit rather than defaulted. `flags: 0` is the minimum-privilege setting:
/// the member may interact with the private account, and sees none of the transaction
/// logs, messages, or balances belonging to anyone else.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PermissionMemberArgs {
    /// The member key.
    pub pubkey: Pubkey,
    /// Visibility flags, as defined by the permission program.
    pub flags: u8,
}

/// Validates a permission member list and converts it for the CPI.
pub fn checked_permission_members(
    members: &[PermissionMemberArgs],
) -> Result<Vec<ephemeral_rollups_sdk::access_control::structs::Member>> {
    require!(
        members.len() <= MAX_INCIDENT_MEMBERS,
        CoreError::TooManyPermissionMembers
    );
    require!(!members.is_empty(), CoreError::PermissionNeedsAMember);
    Ok(members
        .iter()
        .map(
            |member| ephemeral_rollups_sdk::access_control::structs::Member {
                flags: member.flags,
                pubkey: member.pubkey,
            },
        )
        .collect())
}

/// Applies one member's decision to their own attestation.
///
/// The nonce floor is the highest the member has ever used, so a superseded nonce cannot be
/// replayed to resurrect an older decision.
///
/// Everything it can refuse is about the submitter: not a member, quarantined, stale nonce,
/// past the deadline, incident closed. None of it varies with anyone else's decision or with
/// how close the incident is to its threshold, so the acknowledgement a member receives
/// carries no information about the quorum.
pub fn apply_attestation(
    core: &IncidentCore,
    attestation: &mut MemberAttestation,
    member: Pubkey,
    decision: Decision,
    submission_nonce: u64,
    now_slot: u64,
) -> Result<()> {
    require!(
        core.status == IncidentStatus::Collecting,
        CoreError::IncidentNotCollecting
    );
    require!(!core.is_expired(now_slot), CoreError::IncidentExpired);
    require!(decision != Decision::None, CoreError::DecisionRequired);
    require_keys_eq!(attestation.member, member, CoreError::NotAnEligibleMember);
    require!(!attestation.is_quarantined(), CoreError::MemberQuarantined);
    require!(
        attestation.state != BallotState::Scrubbed,
        CoreError::IncidentNotCollecting
    );
    require!(
        submission_nonce > attestation.submission_nonce,
        CoreError::NonceNotIncreasing
    );

    attestation.decision = decision;
    attestation.submission_nonce = submission_nonce;
    attestation.submitted_at_slot = now_slot;
    attestation.has_decision = true;
    attestation.state = BallotState::Submitted;
    attestation.private_fields_zeroized = false;
    Ok(())
}

/// Everything an unauthorised observer may learn.
///
/// This is not a filtered view of a private account any more. It is a straight read of
/// [`IncidentCore`], which is public precisely because it contains nothing else.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PublicIncidentView {
    /// The incident.
    pub incident_id: u64,
    /// Lifecycle status only.
    pub status: IncidentStatus,
    /// The deadline.
    pub expires_at_slot: u64,
}

/// Reduces an incident to the observer-safe view.
pub fn public_view(core: &IncidentCore) -> PublicIncidentView {
    PublicIncidentView {
        incident_id: core.incident_id,
        status: core.status,
        expires_at_slot: core.expires_at_slot,
    }
}

/// Checks that a certificate matches an incident's frozen snapshot.
pub fn certificate_matches(
    core: &IncidentCore,
    certificate: &Account<IncidentCertificate>,
) -> Result<()> {
    require!(
        certificate.covenant == core.covenant,
        CoreError::CertificateMismatch
    );
    require!(
        certificate.circle_epoch == core.circle_epoch,
        CoreError::CertificateMismatch
    );
    require!(
        certificate.incident_id == core.incident_id,
        CoreError::CertificateMismatch
    );
    require!(
        certificate.policy_id == core.policy_id,
        CoreError::CertificateMismatch
    );
    require!(
        certificate.member_set_hash == core.member_set_hash,
        CoreError::CertificateMismatch
    );
    Ok(())
}

/// The certificate seed, re-exported so callers derive it from one place.
pub const fn certificate_seed() -> &'static [u8] {
    CERTIFICATE_SEED
}

//! Covenant formation and ratification.
//!
//! The covenant is the thing an incident is answerable to. Before it exists, an incident's
//! opener supplies the member set, the threshold, and the response window, and nothing stops
//! them supplying a convenient one. After it exists, all of that is copied out of a ratified
//! covenant and the opener supplies none of it.
//!
//! Formation is a sequence of separate signatures rather than one authority's decision.
//! The steward convenes and adds members; each protocol authority ratifies its own
//! membership; ratification of the covenant requires every member to have done so; and each
//! protocol arms its own adapter independently. The steward never gains the ability to
//! ratify or arm on anyone's behalf, which is the same sovereignty rule the adapter enforces
//! from the other side.
//!
//! Two accounts, both public and both on the base layer. Nothing here is private: a covenant
//! is a published commitment, and an observer being able to read who agreed to what is the
//! point of it.

use anchor_lang::prelude::*;

use crate::incident::{member_set_commitment, INCIDENT_SCHEMA_VERSION, MAX_INCIDENT_MEMBERS};
use crate::CoreError;

/// Seed for a covenant.
pub const COVENANT_SEED: &[u8] = b"covenant";
/// Seed for one protocol's membership of a covenant.
pub const COVENANT_MEMBER_SEED: &[u8] = b"member";

/// What a member is in the circle for. Mirrors `vinct_types::covenant::MemberRole`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum MemberRole {
    /// A protocol that owns an adapter and may attest.
    #[default]
    Protocol,
    /// A security responder that may attest but owns no adapter.
    Responder,
    /// The steward. Convenes formation and never gains protocol authority.
    Steward,
}

impl MemberRole {
    /// Whether this role has an adapter that must be armed before the circle is.
    ///
    /// A responder attests and owns nothing, so waiting for it to arm would deadlock a
    /// circle that is otherwise ready.
    pub fn owns_an_adapter(&self) -> bool {
        matches!(self, MemberRole::Protocol)
    }
}

/// Where a covenant sits. Mirrors PRD section 11.1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CovenantStatus {
    /// Members are still being added. Nothing is frozen.
    #[default]
    Draft,
    /// Every member has ratified. The member set and policy are frozen.
    Ratified,
    /// Every adapter-owning member has armed. Incidents may open.
    Armed,
    /// Paused by the ratification authorities. No new incident may open.
    Suspended,
    /// Past its expiry slot.
    Expired,
    /// Replaced by a later epoch.
    Superseded,
}

impl CovenantStatus {
    /// True when the circle can take on a new incident.
    ///
    /// Only `Armed`. A ratified covenant whose adapters are not armed has agreed what to do
    /// and cannot do it, and opening an incident against it would collect attestations
    /// toward an action that could not run.
    pub fn may_open_an_incident(&self) -> bool {
        matches!(self, CovenantStatus::Armed)
    }
}

/// A ratified circle.
#[account]
pub struct Covenant {
    /// Schema version.
    pub version: u16,
    /// The steward that convened formation. Holds no protocol authority.
    pub steward: Pubkey,
    /// Stable identity within the steward's namespace.
    pub covenant_id: u64,
    /// The epoch. A membership or policy change makes a new one.
    pub circle_epoch: u64,
    /// The cluster this covenant is bound to.
    pub cluster_genesis_hash: [u8; 32],
    /// Lifecycle status.
    pub status: CovenantStatus,
    /// The policy this covenant's incidents run under.
    pub policy_id: [u8; 32],
    /// The action template the policy commits to.
    ///
    /// Feeds the operation ID rather than the concrete bundle, because receipt addresses in
    /// the concrete bundle depend on the operation ID and cannot also be an input to it. See
    /// docs/decision-log.md D-0012.
    pub action_bundle_template_hash: [u8; 32],
    /// Approvals required to certify.
    pub required_approvals: u8,
    /// Rejections that block certification.
    pub maximum_rejections: u8,
    /// How long an incident stays open.
    pub response_window_slots: u64,
    /// How long a certificate remains usable after it is issued.
    pub certificate_lifetime_slots: u64,
    /// Members added so far.
    pub member_count: u8,
    /// Members that have ratified their own membership.
    pub ratified_count: u8,
    /// Adapter-owning members that have armed.
    pub armed_count: u8,
    /// Adapter-owning members, which is how many arms are needed.
    pub adapter_count: u8,
    /// The member set, frozen at ratification. Zero until then.
    ///
    /// Computed by the program over the members supplied at ratification, in the same
    /// canonical form an incident's ballot set is checked against, so the two are the same
    /// commitment and an incident can be bound to a covenant by a single equality.
    pub member_set_hash: [u8; 32],
    /// First slot this epoch is valid.
    pub valid_from_slot: u64,
    /// Slot this epoch expires.
    pub expires_at_slot: u64,
    /// PDA bump.
    pub bump: u8,
}

impl Covenant {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize =
        2 + 32 + 8 + 8 + 32 + 1 + 32 + 32 + 1 + 1 + 8 + 8 + 1 + 1 + 1 + 1 + 32 + 8 + 8 + 1;

    /// True when `now_slot` is outside the epoch's validity window.
    pub fn is_out_of_window(&self, now_slot: u64) -> bool {
        now_slot < self.valid_from_slot || now_slot >= self.expires_at_slot
    }
}

/// One protocol's membership of one covenant.
///
/// Separate from the covenant so each protocol signs its own account and nothing else. A
/// member list held inside the covenant would need one writer, and that writer would be able
/// to ratify on everyone's behalf.
#[account]
pub struct CovenantMember {
    /// Schema version.
    pub version: u16,
    /// The covenant.
    pub covenant: Pubkey,
    /// The protocol authority.
    pub protocol: Pubkey,
    /// What this member is here for.
    pub role: MemberRole,
    /// The adapter capability this member owns, or the default when it owns none.
    pub adapter_capability: Pubkey,
    /// The adapter version this member has armed. Zero until it arms.
    pub adapter_version: u16,
    /// Whether this protocol has ratified its own membership.
    pub ratified: bool,
    /// Whether this protocol has armed its adapter.
    pub armed: bool,
    /// PDA bump.
    pub bump: u8,
}

impl CovenantMember {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 2 + 32 + 32 + 1 + 32 + 2 + 1 + 1 + 1;
}

/// Arguments for convening a covenant.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateCovenantArgs {
    /// Stable identity within the steward's namespace.
    pub covenant_id: u64,
    /// The epoch this covenant starts at.
    pub circle_epoch: u64,
    /// The cluster to bind to.
    pub cluster_genesis_hash: [u8; 32],
    /// The policy this covenant's incidents run under.
    pub policy_id: [u8; 32],
    /// The action template the policy commits to.
    ///
    /// Feeds the operation ID rather than the concrete bundle, because receipt addresses in
    /// the concrete bundle depend on the operation ID and cannot also be an input to it. See
    /// docs/decision-log.md D-0012.
    pub action_bundle_template_hash: [u8; 32],
    /// Approvals required to certify.
    pub required_approvals: u8,
    /// Rejections that block certification.
    pub maximum_rejections: u8,
    /// How long an incident stays open.
    pub response_window_slots: u64,
    /// How long a certificate remains usable.
    pub certificate_lifetime_slots: u64,
    /// Slots this epoch remains valid.
    pub epoch_lifetime_slots: u64,
}

/// Validates the terms a covenant is created with.
///
/// The threshold is checked again at ratification against the members that actually joined,
/// because a covenant convened with a threshold of three and ratified with two members would
/// otherwise be permanently unable to certify anything.
pub fn check_terms(args: &CreateCovenantArgs) -> Result<()> {
    require!(args.required_approvals > 0, CoreError::ZeroThreshold);
    require!(
        usize::from(args.required_approvals) <= MAX_INCIDENT_MEMBERS,
        CoreError::ThresholdExceedsMembers
    );
    require!(
        args.response_window_slots > 0,
        CoreError::ZeroResponseWindow
    );
    require!(
        args.certificate_lifetime_slots > 0,
        CoreError::ZeroResponseWindow
    );
    require!(args.epoch_lifetime_slots > 0, CoreError::ZeroResponseWindow);
    require!(
        args.action_bundle_template_hash != [0u8; 32],
        CoreError::ZeroActionBundleHash
    );
    Ok(())
}

/// Reads one member account supplied at ratification, checked before it is believed.
///
/// Owner, schema version, the covenant it claims to belong to, and its canonical address
/// derived from that covenant and the protocol it names. The address check is what makes the
/// `protocol` field trustworthy.
pub fn read_member(info: &AccountInfo, covenant: Pubkey) -> Result<CovenantMember> {
    require_keys_eq!(*info.owner, crate::ID, CoreError::IncidentWrongOwner);
    let member = CovenantMember::try_deserialize(&mut &info.try_borrow_data()?[..])
        .map_err(|_| error!(CoreError::IncidentAccountMalformed))?;
    require!(
        member.version == INCIDENT_SCHEMA_VERSION,
        CoreError::UnsupportedSchemaVersion
    );
    require_keys_eq!(member.covenant, covenant, CoreError::OperationMismatch);

    let (expected, _) = Pubkey::find_program_address(
        &[
            COVENANT_MEMBER_SEED,
            covenant.as_ref(),
            member.protocol.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(info.key(), expected, CoreError::OperationMismatch);
    Ok(member)
}

/// Reconstructs the covenant's member set from the accounts supplied at ratification.
///
/// The same shape certification uses on ballots, and deliberately so: both end in
/// [`member_set_commitment`] over a strictly ascending list, so a covenant's frozen set and
/// an incident's ballot set are the same commitment and can be compared with one equality.
pub fn reconstruct_members(
    covenant: &Covenant,
    covenant_key: Pubkey,
    supplied: &[AccountInfo],
) -> Result<([u8; 32], u8)> {
    require!(
        supplied.len() == usize::from(covenant.member_count),
        CoreError::AttestationCountMismatch
    );

    let mut protocols: Vec<Pubkey> = Vec::with_capacity(supplied.len());
    let mut adapters: u8 = 0;
    for info in supplied.iter() {
        let member = read_member(info, covenant_key)?;
        require!(member.ratified, CoreError::MemberHasNotRatified);
        if let Some(previous) = protocols.last() {
            require!(
                previous.to_bytes() < member.protocol.to_bytes(),
                CoreError::MemberSetNotAscending
            );
        }
        if member.role.owns_an_adapter() {
            adapters = adapters.saturating_add(1);
        }
        protocols.push(member.protocol);
    }

    Ok((member_set_commitment(&protocols)?, adapters))
}

//! VINCT core.
//!
//! Phase 2 scope: the certificate account an adapter validates against, the settlement
//! receipt a completed cohort writes, and the two instructions that create them. The
//! covenant registry, incident lifecycle, PER permissions, and Magic Action scheduling
//! arrive in later phases and extend this program rather than replacing it.
//!
//! One rule shapes everything here: a certificate is a *published fact*, not a request.
//! It carries no authority of its own and grants none. An adapter reads it, checks it
//! against bounds its own protocol authority set, and decides. Nothing in this program can
//! make an adapter act.

// Anchor 1.0.2's `#[program]` expansion trips these in its generated dispatch and error
// plumbing, not in code written here. Scoped to this crate so a genuine occurrence in
// VINCT's own logic still fails the lint gate.
#![allow(clippy::diverging_sub_expression)]
#![allow(clippy::result_large_err)]
// No unsafe, enforced by the compiler rather than by a code-review habit. VINCT's rule is that
// unsafe needs written approval, and a rule a build cannot check is a rule that holds until
// somebody is in a hurry.
#![forbid(unsafe_code)]

pub mod covenant;
pub mod incident;

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED,
};
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

declare_id!("9BaZmGntudyAL5VodBWFCANchn7vx1Y7DNpXADbx6JcG");

/// Seed for a certificate account.
pub const CERTIFICATE_SEED: &[u8] = b"certificate";
/// Seed for a settlement receipt.
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
/// Seed for the PDA that signs settlement receipts written by a Magic Action.
pub const SETTLEMENT_AUTHORITY_SEED: &[u8] = b"settlement-authority";
/// Seed for the delegated settlement operation account.
pub const OPERATION_SEED: &[u8] = b"operation";

/// Domain separator for the expiry task ID.
pub const EXPIRY_TASK_DOMAIN: &[u8] = b"vinct:expiry-task:v1";

/// The most iterations one expiry task may request.
///
/// Finite on purpose. An unbounded task outlives the incident it was scheduled for, keeps the
/// incident's accounts pinned to the rollup, and turns every later failure into a repeating
/// one. Renewal is a deliberate act, and the manual expiry path exists precisely so exhaustion
/// is inconvenient rather than dangerous.
pub const MAX_EXPIRY_ITERATIONS: i64 = 64;

/// This build's fingerprint: SHA-256 over every source file in the crate, computed by
/// `build.rs`.
///
/// Exists because a successful base-layer upgrade does not prove that a given ephemeral
/// rollup is executing the new binary. `build_info` returns this, and a proof run compares
/// the ER's answer against base's and against the value that was actually built. See
/// docs/decision-log.md D-0030.
pub const BUILD_FINGERPRINT: &str = env!("VINCT_BUILD_FINGERPRINT");

/// Accounts each adapter action needs beyond the shared certificate and target program.
///
/// The scheduler receives them through `remaining_accounts` in exactly this repeating
/// shape, because Anchor contexts cannot express a variable-length group of typed accounts.
pub const ACCOUNTS_PER_ADAPTER_ACTION: usize = 4;

#[ephemeral]
#[program]
pub mod vinct_core {
    use super::*;

    /// Publishes the certificate a certified incident earned.
    ///
    /// Every field is derived from the released incident core. Nothing is an argument, and
    /// there is no issuing authority to hold: the incident's own terminal state is the
    /// authority, and it reached that state by collecting the covenant's threshold inside
    /// the private runtime. An adapter asking which key stood behind a certificate gets the
    /// incident itself, which is a better answer than a wallet.
    ///
    /// Permissionless, for the same reason certification and the scrub are. An incident that
    /// certified must be able to produce its certificate, and requiring a signature would
    /// hand whoever held it a veto over an outcome the covenant had already reached.
    ///
    /// The certificate carries the template hash rather than a concrete bundle hash. The
    /// concrete bundle's receipt addresses depend on the operation ID, so the bundle cannot
    /// also be an input to it. The binding runs through the operation ID, which commits to
    /// the template and to every frozen snapshot field. See docs/decision-log.md D-0012.
    pub fn publish_certificate(ctx: Context<PublishCertificate>) -> Result<()> {
        let core = &ctx.accounts.core;
        require!(
            core.status == incident::IncidentStatus::CertifiedPendingSettlement,
            CoreError::IncidentNotCertified
        );
        require!(core.operation_id != [0u8; 32], CoreError::ZeroOperationId);
        require!(
            core.action_bundle_template_hash != [0u8; 32],
            CoreError::ZeroActionBundleHash
        );
        require!(
            core.approval_count_after_terminal > 0,
            CoreError::CertificateWithoutApprovals
        );

        let expires_at_slot = core
            .certified_at_slot
            .checked_add(core.certificate_lifetime_slots)
            .ok_or(CoreError::ArithmeticOverflow)?;
        require!(
            expires_at_slot > core.certified_at_slot,
            CoreError::CertificateExpiresBeforeIssue
        );

        let issuing_authority = core.key();
        let cluster_genesis_hash = core.cluster_genesis_hash;
        let covenant = core.covenant;
        let circle_epoch = core.circle_epoch;
        let incident_id = core.incident_id;
        let policy_id = core.policy_id;
        let member_set_hash = core.member_set_hash;
        let action_bundle_hash = core.action_bundle_template_hash;
        let operation_id = core.operation_id;
        let certified_at_slot = core.certified_at_slot;
        let approval_count = core.approval_count_after_terminal;
        let rejection_count = core.rejection_count_after_terminal;

        let certificate = &mut ctx.accounts.certificate;
        certificate.issuing_authority = issuing_authority;
        certificate.cluster_genesis_hash = cluster_genesis_hash;
        certificate.covenant = covenant;
        certificate.circle_epoch = circle_epoch;
        certificate.incident_id = incident_id;
        certificate.policy_id = policy_id;
        certificate.member_set_hash = member_set_hash;
        certificate.action_bundle_hash = action_bundle_hash;
        certificate.operation_id = operation_id;
        certificate.certificate_nonce = certified_at_slot;
        certificate.approval_count = approval_count;
        certificate.rejection_count = rejection_count;
        certificate.certified_at_slot = certified_at_slot;
        certificate.expires_at_slot = expires_at_slot;
        certificate.bump = ctx.bumps.certificate;
        Ok(())
    }

    /// Creates the settlement receipt account before any action is scheduled.
    ///
    /// Phase 0 established that `#[action]` injects `escrow_auth` as a non-mutable
    /// `UncheckedAccount`, so a Magic Action target cannot create its own accounts. The
    /// receipt is therefore created here, in an ordinary base-layer transaction, and the
    /// action only writes to it. See docs/decision-log.md D-0015.
    pub fn initialize_settlement_receipt(
        ctx: Context<InitializeSettlementReceipt>,
        operation_id: [u8; 32],
    ) -> Result<()> {
        require!(operation_id != [0u8; 32], CoreError::ZeroOperationId);
        let receipt = &mut ctx.accounts.settlement_receipt;
        receipt.operation_id = operation_id;
        receipt.certificate = ctx.accounts.certificate.key();
        receipt.finalized = false;
        receipt.observed_action_count = 0;
        receipt.finalized_at_slot = 0;
        receipt.bump = ctx.bumps.settlement_receipt;
        Ok(())
    }

    // ------------------------------------------------------------------------
    // Covenant formation
    // ------------------------------------------------------------------------

    /// Base layer. Convenes a covenant.
    ///
    /// The steward signs and holds nothing else. It can add members and it cannot ratify for
    /// them, arm for them, or act on their protocols. Every later step needs the protocol
    /// authority's own signature.
    pub fn create_covenant(
        ctx: Context<CreateCovenant>,
        args: covenant::CreateCovenantArgs,
    ) -> Result<()> {
        covenant::check_terms(&args)?;
        let clock = Clock::get()?;
        let account = &mut ctx.accounts.covenant;
        account.version = incident::INCIDENT_SCHEMA_VERSION;
        account.steward = ctx.accounts.steward.key();
        account.covenant_id = args.covenant_id;
        account.circle_epoch = args.circle_epoch;
        account.cluster_genesis_hash = args.cluster_genesis_hash;
        account.status = covenant::CovenantStatus::Draft;
        account.policy_id = args.policy_id;
        account.action_bundle_template_hash = args.action_bundle_template_hash;
        account.required_approvals = args.required_approvals;
        account.maximum_rejections = args.maximum_rejections;
        account.response_window_slots = args.response_window_slots;
        account.certificate_lifetime_slots = args.certificate_lifetime_slots;
        account.valid_from_slot = clock.slot;
        account.expires_at_slot = clock
            .slot
            .checked_add(args.epoch_lifetime_slots)
            .ok_or(CoreError::ArithmeticOverflow)?;
        account.bump = ctx.bumps.covenant;
        Ok(())
    }

    /// Base layer. Adds one protocol to a draft covenant.
    ///
    /// Only while the covenant is still a draft. After ratification the member set is frozen,
    /// and a membership change is a new epoch rather than an edit, because incidents already
    /// in flight carry the epoch they opened under.
    pub fn add_covenant_member(
        ctx: Context<AddCovenantMember>,
        protocol: Pubkey,
        role: covenant::MemberRole,
        adapter_capability: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.covenant.status == covenant::CovenantStatus::Draft,
            CoreError::CovenantNotDraft
        );
        require!(
            usize::from(ctx.accounts.covenant.member_count) < incident::MAX_INCIDENT_MEMBERS,
            CoreError::TooManyPermissionMembers
        );

        let member = &mut ctx.accounts.member;
        member.version = incident::INCIDENT_SCHEMA_VERSION;
        member.covenant = ctx.accounts.covenant.key();
        member.protocol = protocol;
        member.role = role;
        member.adapter_capability = adapter_capability;
        member.bump = ctx.bumps.member;

        let account = &mut ctx.accounts.covenant;
        account.member_count = account.member_count.saturating_add(1);
        Ok(())
    }

    /// Base layer. One protocol ratifies its own membership.
    ///
    /// The protocol authority signs. Nobody can do this for them, which is what makes the
    /// ratified count mean something.
    pub fn ratify_covenant_member(ctx: Context<CovenantMemberAction>) -> Result<()> {
        require!(
            ctx.accounts.covenant.status == covenant::CovenantStatus::Draft,
            CoreError::CovenantNotDraft
        );
        require!(!ctx.accounts.member.ratified, CoreError::AlreadyRatified);
        ctx.accounts.member.ratified = true;

        let account = &mut ctx.accounts.covenant;
        account.ratified_count = account.ratified_count.saturating_add(1);
        Ok(())
    }

    /// Base layer. Freezes the member set once every member has ratified.
    ///
    /// Every member account is supplied in `remaining_accounts`, strictly ascending by
    /// protocol authority, and the commitment is computed here rather than accepted. It is
    /// the same commitment an incident's ballot set is later checked against, so binding an
    /// incident to a covenant is one equality rather than a second scheme.
    ///
    /// Permissionless. Every signature that matters was already collected, and requiring one
    /// more would let whoever held it stall a circle that had already agreed.
    pub fn ratify_covenant<'info>(ctx: Context<'info, RatifyCovenant<'info>>) -> Result<()> {
        require!(
            ctx.accounts.covenant.status == covenant::CovenantStatus::Draft,
            CoreError::CovenantNotDraft
        );
        require!(
            ctx.accounts.covenant.member_count > 0,
            CoreError::PermissionNeedsAMember
        );
        require!(
            ctx.accounts.covenant.ratified_count == ctx.accounts.covenant.member_count,
            CoreError::MemberHasNotRatified
        );
        require!(
            ctx.accounts.covenant.required_approvals <= ctx.accounts.covenant.member_count,
            CoreError::ThresholdExceedsMembers
        );

        let key = ctx.accounts.covenant.key();
        let (member_set_hash, adapter_count) =
            covenant::reconstruct_members(&ctx.accounts.covenant, key, ctx.remaining_accounts)?;

        let account = &mut ctx.accounts.covenant;
        account.member_set_hash = member_set_hash;
        account.adapter_count = adapter_count;
        account.status = covenant::CovenantStatus::Ratified;
        Ok(())
    }

    /// Base layer. One protocol arms its own adapter at a version.
    ///
    /// Separate from ratification because agreeing to a covenant and being ready to act under
    /// it are different commitments, and a protocol may want the first without the second yet.
    pub fn arm_covenant_member(
        ctx: Context<CovenantMemberAction>,
        adapter_version: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.covenant.status == covenant::CovenantStatus::Ratified
                || ctx.accounts.covenant.status == covenant::CovenantStatus::Armed,
            CoreError::CovenantNotRatified
        );
        require!(
            ctx.accounts.member.role.owns_an_adapter(),
            CoreError::MemberOwnsNoAdapter
        );
        require!(adapter_version > 0, CoreError::ZeroAdapterVersion);
        require!(!ctx.accounts.member.armed, CoreError::AlreadyArmed);

        ctx.accounts.member.armed = true;
        ctx.accounts.member.adapter_version = adapter_version;

        let account = &mut ctx.accounts.covenant;
        account.armed_count = account.armed_count.saturating_add(1);
        Ok(())
    }

    /// Base layer. Arms the circle once every adapter-owning member has armed.
    pub fn arm_covenant(ctx: Context<ArmCovenant>) -> Result<()> {
        require!(
            ctx.accounts.covenant.status == covenant::CovenantStatus::Ratified,
            CoreError::CovenantNotRatified
        );
        require!(
            ctx.accounts.covenant.armed_count == ctx.accounts.covenant.adapter_count,
            CoreError::AdapterNotArmed
        );
        ctx.accounts.covenant.status = covenant::CovenantStatus::Armed;
        Ok(())
    }

    // ------------------------------------------------------------------------
    // Private incident lifecycle
    // ------------------------------------------------------------------------

    /// Base layer. Creates the public incident core, bound to a ratified covenant.
    ///
    /// The snapshot is copied out of the covenant, not supplied. Threshold, rejection
    /// ceiling, response window, policy, epoch, and the frozen member set all come from an
    /// armed circle that its members ratified, so the responder who opens an incident cannot
    /// choose a set or a threshold that suits them.
    ///
    /// Freezing happens here, on the base layer, where the covenant is authoritative. The
    /// ephemeral rollup later checks ballots against the frozen commitment and never has to
    /// read the covenant at all, which also means it can never read a stale clone of one.
    ///
    /// Nothing on this account is private, so nothing here is permissioned. It is what an
    /// observer reads to learn that an incident is open and when it closes, and it is
    /// deliberately incapable of telling them anything else.
    pub fn initialize_incident(
        ctx: Context<InitializeIncident>,
        incident_id: u64,
        covenant: Pubkey,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let circle = &ctx.accounts.covenant_account;
        require_keys_eq!(covenant, circle.key(), CoreError::OperationMismatch);
        require!(
            circle.status.may_open_an_incident(),
            CoreError::CovenantNotArmed
        );
        require!(
            !circle.is_out_of_window(clock.slot),
            CoreError::CovenantOutOfWindow
        );
        require!(
            ctx.accounts.opener_membership.ratified,
            CoreError::MemberHasNotRatified
        );

        let core = &mut ctx.accounts.core;
        core.version = incident::INCIDENT_SCHEMA_VERSION;
        core.covenant = covenant;
        core.incident_id = incident_id;
        core.opener = ctx.accounts.opener.key();
        core.status = incident::IncidentStatus::Draft;
        core.circle_epoch = circle.circle_epoch;
        core.policy_id = circle.policy_id;
        core.action_bundle_template_hash = circle.action_bundle_template_hash;
        core.certificate_lifetime_slots = circle.certificate_lifetime_slots;
        core.member_set_hash = circle.member_set_hash;
        core.cluster_genesis_hash = circle.cluster_genesis_hash;
        core.required_approvals = circle.required_approvals;
        core.maximum_rejections = circle.maximum_rejections;
        core.member_count = circle.member_count;
        core.response_window_slots = circle.response_window_slots;
        core.bump = ctx.bumps.core;
        Ok(())
    }

    /// Base layer. Creates the private claim account.
    ///
    /// Pre-funded for its own ER-local permission, because a delegated account pays that
    /// rent itself once it is inside the rollup and cannot be topped up from base afterwards.
    pub fn initialize_claim(ctx: Context<InitializeClaim>) -> Result<()> {
        fund_for_permission(
            &ctx.accounts.system_program,
            &ctx.accounts.opener,
            &ctx.accounts.claim.to_account_info(),
            incident::MAX_INCIDENT_MEMBERS,
        )?;
        let claim = &mut ctx.accounts.claim;
        claim.version = incident::INCIDENT_SCHEMA_VERSION;
        claim.incident = ctx.accounts.core.key();
        claim.opener = ctx.accounts.core.opener;
        claim.private_fields_zeroized = true;
        claim.bump = ctx.bumps.claim;
        Ok(())
    }

    /// Base layer. Creates one member's attestation account.
    ///
    /// Created for every member before the incident opens, whether or not that member ever
    /// responds. An account that appeared only when a member voted would announce that they
    /// had, which is exactly the thing this design exists to hide.
    pub fn initialize_attestation(
        ctx: Context<InitializeAttestation>,
        member: Pubkey,
    ) -> Result<()> {
        // The membership account proves this key is in the covenant this incident froze. A
        // ballot for anyone else could never be counted, because the frozen commitment would
        // not match, but refusing it here says so at the point the mistake is made.
        require_keys_eq!(
            ctx.accounts.membership.protocol,
            member,
            CoreError::NotAnEligibleMember
        );
        require_keys_eq!(
            ctx.accounts.membership.covenant,
            ctx.accounts.core.covenant,
            CoreError::OperationMismatch
        );
        require!(
            ctx.accounts.membership.ratified,
            CoreError::MemberHasNotRatified
        );

        fund_for_permission(
            &ctx.accounts.system_program,
            &ctx.accounts.opener,
            &ctx.accounts.attestation.to_account_info(),
            1,
        )?;
        let attestation = &mut ctx.accounts.attestation;
        attestation.version = incident::INCIDENT_SCHEMA_VERSION;
        attestation.incident = ctx.accounts.core.key();
        attestation.member = member;
        attestation.opener = ctx.accounts.core.opener;
        attestation.private_fields_zeroized = true;
        attestation.bump = ctx.bumps.attestation;
        Ok(())
    }

    /// Base layer. Delegates the public core.
    ///
    /// The opener is checked by hand because `#[delegate]` needs the account untyped, so
    /// there is no `has_one` to lean on. It matters more than the untyped account makes it
    /// look: the caller chooses the validator, and a stranger who could delegate someone
    /// else's incident would be choosing which rollup that responder's private material
    /// later lands on.
    pub fn delegate_incident(
        ctx: Context<DelegateIncident>,
        incident_id: u64,
        covenant: Pubkey,
    ) -> Result<()> {
        require_opener_of_core(&ctx.accounts.core, ctx.accounts.opener.key())?;
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_core(
            &ctx.accounts.opener,
            &[
                incident::INCIDENT_SEED,
                covenant.as_ref(),
                &incident_id.to_le_bytes(),
            ],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Base layer. Delegates the private claim.
    ///
    /// The opener is read off the claim rather than off the core, because by the time this
    /// runs the core is already delegated and therefore owned by the delegation program. An
    /// account that has left cannot vouch for one that has not.
    pub fn delegate_claim(ctx: Context<DelegateClaim>, core: Pubkey) -> Result<()> {
        {
            require_keys_eq!(
                *ctx.accounts.claim.owner,
                crate::ID,
                CoreError::IncidentWrongOwner
            );
            let data = ctx.accounts.claim.try_borrow_data()?;
            let claim = incident::IncidentClaim::try_deserialize(&mut &data[..])
                .map_err(|_| error!(CoreError::IncidentAccountMalformed))?;
            require_keys_eq!(claim.incident, core, CoreError::OperationMismatch);
            require_keys_eq!(
                claim.opener,
                ctx.accounts.opener.key(),
                CoreError::NotTheOpener
            );
        }
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_claim(
            &ctx.accounts.opener,
            &[incident::CLAIM_SEED, core.as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Base layer. Delegates one member's attestation.
    pub fn delegate_attestation(
        ctx: Context<DelegateAttestation>,
        core: Pubkey,
        member: Pubkey,
    ) -> Result<()> {
        {
            require_keys_eq!(
                *ctx.accounts.attestation.owner,
                crate::ID,
                CoreError::IncidentWrongOwner
            );
            let data = ctx.accounts.attestation.try_borrow_data()?;
            let attestation = incident::MemberAttestation::try_deserialize(&mut &data[..])
                .map_err(|_| error!(CoreError::IncidentAccountMalformed))?;
            require_keys_eq!(attestation.incident, core, CoreError::OperationMismatch);
            require_keys_eq!(attestation.member, member, CoreError::NotAnEligibleMember);
            require_keys_eq!(
                attestation.opener,
                ctx.accounts.opener.key(),
                CoreError::NotTheOpener
            );
        }
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_attestation(
            &ctx.accounts.opener,
            &[incident::ATTESTATION_SEED, core.as_ref(), member.as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Ephemeral rollup. Makes the claim readable by the incident's members and nobody else.
    ///
    /// Created already private with the member list in place, rather than public and then
    /// flipped. A window in which the account is readable is a window in which it is
    /// readable, and there is no reason to open one.
    pub fn create_claim_permission(
        ctx: Context<ClaimPermissionAuthority>,
        members: Vec<incident::PermissionMemberArgs>,
    ) -> Result<()> {
        let permission_members = incident::checked_permission_members(&members)?;
        let core = ctx.accounts.claim.incident;
        let seeds = [
            incident::CLAIM_SEED,
            core.as_ref(),
            &[ctx.accounts.claim.bump],
        ];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.claim.to_account_info(),
            permissioned_account: ctx.accounts.claim.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: permission_members,
            },
        }
        .invoke_signed(&[&seeds])?;
        Ok(())
    }

    /// Ephemeral rollup. Replaces the claim's member list.
    pub fn update_claim_permission(
        ctx: Context<ClaimPermissionAuthority>,
        is_private: bool,
        members: Vec<incident::PermissionMemberArgs>,
    ) -> Result<()> {
        let permission_members = incident::checked_permission_members(&members)?;
        let core = ctx.accounts.claim.incident;
        let seeds = [
            incident::CLAIM_SEED,
            core.as_ref(),
            &[ctx.accounts.claim.bump],
        ];
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.claim.to_account_info(),
            permissioned_account: ctx.accounts.claim.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.claim.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private,
                members: permission_members,
            },
        }
        .invoke_signed(&[&seeds])?;
        Ok(())
    }

    /// Ephemeral rollup. Makes one attestation readable by its own member and nobody else.
    ///
    /// The member list is not a parameter. It is read off the account, so there is no
    /// argument a caller could pass that would put a second reader on someone's ballot.
    pub fn create_attestation_permission(ctx: Context<AttestationPermission>) -> Result<()> {
        let attestation = &ctx.accounts.attestation;
        let core = attestation.incident;
        let member = attestation.member;
        let seeds = [
            incident::ATTESTATION_SEED,
            core.as_ref(),
            member.as_ref(),
            &[attestation.bump],
        ];
        CreateEphemeralPermissionCpi {
            payer: attestation.to_account_info(),
            permissioned_account: attestation.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: 0,
                    pubkey: member,
                }],
            },
        }
        .invoke_signed(&[&seeds])?;
        Ok(())
    }

    /// Ephemeral rollup. Opens the incident and freezes its snapshot.
    pub fn open_incident<'info>(
        ctx: Context<'info, OpenIncident<'info>>,
        claim_digest: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let core_key = ctx.accounts.core.key();
        require!(
            ctx.accounts.core.status == incident::IncidentStatus::Draft,
            CoreError::IncidentAlreadyOpened
        );

        // The ballots have to be the covenant's frozen set, which was copied onto this core
        // when it was created. Nothing about the set is an argument to this instruction, so
        // there is nothing for the opener to choose.
        let ballots =
            reconstruct_frozen_ballots(&ctx.accounts.core, core_key, ctx.remaining_accounts)?;
        for ballot in &ballots {
            require!(
                ballot.state == incident::BallotState::Empty,
                CoreError::BallotNotCountable
            );
        }

        let core = &mut ctx.accounts.core;
        core.opened_at_slot = clock.slot;
        core.expires_at_slot = clock
            .slot
            .checked_add(core.response_window_slots)
            .ok_or(CoreError::ArithmeticOverflow)?;
        core.claim_digest = claim_digest;
        core.status = incident::IncidentStatus::Collecting;
        Ok(())
    }

    /// Ephemeral rollup. Stores the raw private claim.
    ///
    /// These bytes never reach the base layer. They live inside the PER, behind the claim's
    /// permission, until the terminal scrub overwrites them.
    pub fn submit_private_claim(
        ctx: Context<SubmitPrivateClaim>,
        args: incident::PrivateClaimArgs,
    ) -> Result<()> {
        require!(
            args.claim.len() <= incident::MAX_PRIVATE_CLAIM,
            CoreError::PrivatePayloadTooLong
        );
        require!(
            args.notes.len() <= incident::MAX_PRIVATE_NOTES,
            CoreError::PrivatePayloadTooLong
        );
        require!(
            ctx.accounts.core.status == incident::IncidentStatus::Collecting,
            CoreError::IncidentNotCollecting
        );
        require_keys_eq!(
            ctx.accounts.responder.key(),
            ctx.accounts.claim.opener,
            CoreError::NotTheOpener
        );

        let claim = &mut ctx.accounts.claim;
        claim.private_claim = [0u8; incident::MAX_PRIVATE_CLAIM];
        claim.private_claim[..args.claim.len()].copy_from_slice(&args.claim);
        claim.private_claim_len = args.claim.len() as u16;
        claim.private_notes = [0u8; incident::MAX_PRIVATE_NOTES];
        claim.private_notes[..args.notes.len()].copy_from_slice(&args.notes);
        claim.private_notes_len = args.notes.len() as u16;
        claim.private_observation_start = args.observation_start;
        claim.private_observation_end = args.observation_end;
        claim.private_fields_zeroized = false;
        Ok(())
    }

    /// Ephemeral rollup. Records one member's sealed decision into their own account.
    ///
    /// The member signs and writes only their own attestation. There is no instruction that
    /// reads anyone else's, and no account here accumulates a running total, so a member
    /// learns that their own submission was accepted and nothing else.
    pub fn submit_sealed_attestation(
        ctx: Context<SubmitSealedAttestation>,
        decision: incident::Decision,
        submission_nonce: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let core = &ctx.accounts.core;
        incident::apply_attestation(
            core,
            &mut ctx.accounts.attestation,
            ctx.accounts.member.key(),
            decision,
            submission_nonce,
            clock.slot,
        )
    }

    /// Ephemeral rollup. Quarantines a member for this incident.
    ///
    /// The opener writes a flag into an account the opener cannot read. That is not a
    /// loophole; it is the property the whole design rests on. Quarantine discards that
    /// member's approval and stops them submitting again, and it never lowers
    /// `required_approvals`. A rejection already cast keeps counting. See
    /// docs/decision-log.md D-0013.
    pub fn quarantine_member(ctx: Context<QuarantineMember>) -> Result<()> {
        require!(
            ctx.accounts.core.status == incident::IncidentStatus::Collecting,
            CoreError::IncidentNotCollecting
        );
        let threshold_before = ctx.accounts.core.required_approvals;
        ctx.accounts.attestation.state = incident::BallotState::Quarantined;
        require!(
            ctx.accounts.core.required_approvals == threshold_before,
            CoreError::QuarantineChangedThreshold
        );
        Ok(())
    }

    /// Ephemeral rollup. Counts every attestation at once and settles the outcome.
    ///
    /// Every attestation account for the incident is passed in `remaining_accounts`, exactly
    /// `member_count` of them, each re-derived from the incident and the member it claims to
    /// belong to. Counting happens in memory and the aggregate is written only when the
    /// outcome is final. There is no running total in any account at any point, which is why
    /// there is nothing for a member to read.
    ///
    /// Permissionless, and it refuses uniformly. Before the deadline it succeeds only when
    /// the threshold is met; otherwise every caller gets `IncidentNotTerminal` regardless of
    /// why, so a caller cannot distinguish "not enough approvals yet" from "already too many
    /// rejections". The one bit it does leak, whether the incident has certified, is the
    /// public status anyway.
    ///
    /// An incident that is going to fail waits for its deadline rather than terminating
    /// early, so the moment a blocking rejection lands is not observable either.
    pub fn certify_incident(ctx: Context<CertifyIncident>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            ctx.accounts.core.status == incident::IncidentStatus::Collecting,
            CoreError::IncidentNotCollecting
        );

        let attestations = reconstruct_frozen_ballots(
            &ctx.accounts.core,
            ctx.accounts.core.key(),
            ctx.remaining_accounts,
        )?;
        let tally = incident::tally(&attestations);
        let certified = tally.meets(&ctx.accounts.core);
        let expired = ctx.accounts.core.is_expired(clock.slot);
        require!(certified || expired, CoreError::IncidentNotTerminal);

        settle_terminal(&mut ctx.accounts.core, &tally, clock.slot);
        Ok(())
    }

    /// Ephemeral rollup. The scheduled terminal handler.
    ///
    /// The same transition `certify_incident` performs, with the opposite failure posture.
    /// `certify_incident` is called by someone who believes the incident is terminal and gets
    /// an error when it is not. This is called by a scheduler that has no idea, so every
    /// reason not to act returns `Ok` and changes nothing.
    ///
    /// Idempotent and monotonic, which are separate properties and both required. Idempotent:
    /// running it twice leaves the same state, because the second run sees a terminal status
    /// and returns. Monotonic: it only ever moves an incident from `Collecting` to a terminal
    /// status, never back, and never between terminal statuses.
    ///
    /// Firing early is normal and does nothing. The scheduler does not guarantee a wall-clock
    /// time, and an incident whose window has not closed still has a threshold that might be
    /// met by someone who has not voted yet. Only the deadline decides.
    ///
    /// Permissionless, and carries no signer. The scheduled transaction is paid and signed by
    /// the validator identity rather than by whoever requested the task, so a handler that
    /// demanded the requester's signature could never run. See docs/decision-log.md D-0059.
    pub fn expire_incident<'info>(ctx: Context<'info, ExpireIncident<'info>>) -> Result<()> {
        let clock = Clock::get()?;
        let core = &ctx.accounts.core;

        // Nothing to do, said three ways. None of them is an error: a scheduler that receives
        // one would keep retrying a task whose work is already finished.
        if core.status != incident::IncidentStatus::Collecting {
            emit!(ExpirySkipped {
                incident_id: core.incident_id,
                reason: ExpirySkipReason::AlreadyTerminal,
            });
            return Ok(());
        }
        if !core.is_expired(clock.slot) {
            emit!(ExpirySkipped {
                incident_id: core.incident_id,
                reason: ExpirySkipReason::WindowStillOpen,
            });
            return Ok(());
        }
        // A ballot set that does not reconstruct is a scheduling mistake, not a reason to
        // guess. Reporting it as skipped keeps the task alive and leaves the manual path open.
        let Ok(attestations) =
            reconstruct_frozen_ballots(core, ctx.accounts.core.key(), ctx.remaining_accounts)
        else {
            emit!(ExpirySkipped {
                incident_id: core.incident_id,
                reason: ExpirySkipReason::BallotSetUnavailable,
            });
            return Ok(());
        };

        let tally = incident::tally(&attestations);
        settle_terminal(&mut ctx.accounts.core, &tally, clock.slot);
        Ok(())
    }

    /// Ephemeral rollup. Asks the scheduler to run `expire_incident` after the deadline.
    ///
    /// The instruction the task will execute is built here, from this incident's own accounts.
    /// A caller supplies the cadence and nothing else. An instruction accepting a caller's
    /// instruction would let anyone schedule arbitrary work under VINCT's identity, which is
    /// the single most dangerous shape a scheduling wrapper can have.
    ///
    /// The task ID is derived, never chosen. It is a domain-separated digest of the cluster,
    /// the covenant, and the incident, so no two VINCT incidents collide, no other application
    /// using a small counter collides with VINCT, and re-requesting the same incident's task
    /// lands on the same ID rather than creating a second one.
    ///
    /// A successful return means the request was accepted. The validator's own log says
    /// `Scheduled task request with ID`. Registration and execution are separate observations
    /// and neither may be inferred from this signature.
    ///
    /// remaining_accounts: the frozen ballot set, in canonical order, which becomes the tail
    /// of the scheduled instruction's account list.
    pub fn request_expiry_crank<'info>(
        ctx: Context<'info, RequestExpiryCrank<'info>>,
        execution_interval_millis: i64,
        iterations: i64,
    ) -> Result<()> {
        require!(execution_interval_millis > 0, CoreError::CrankIntervalZero);
        require!(
            iterations > 0 && iterations <= MAX_EXPIRY_ITERATIONS,
            CoreError::CrankIterationsOutOfRange
        );
        require!(
            ctx.accounts.core.status == incident::IncidentStatus::Collecting,
            CoreError::IncidentNotCollecting
        );
        // Reconstructed rather than trusted, exactly as certification does. The accounts that
        // go into a scheduled instruction are accounts nobody will re-check at execution time,
        // so this is the last moment they can be checked at all.
        reconstruct_frozen_ballots(
            &ctx.accounts.core,
            ctx.accounts.core.key(),
            ctx.remaining_accounts,
        )?;

        let mut accounts = vec![AccountMeta::new(ctx.accounts.core.key(), false)];
        for ballot in ctx.remaining_accounts {
            accounts.push(AccountMeta::new_readonly(ballot.key(), false));
        }
        let inner = Instruction {
            program_id: crate::ID,
            accounts,
            data: anchor_lang::InstructionData::data(&crate::instruction::ExpireIncident {}),
        };

        let task_id = expiry_task_id(&ctx.accounts.core);
        let data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id,
            execution_interval_millis,
            iterations,
            instructions: vec![inner],
        }))
        .map_err(|_| error!(CoreError::CrankEncodingFailed))?;

        invoke(
            &Instruction::new_with_bytes(
                MAGIC_PROGRAM_ID,
                &data,
                vec![
                    AccountMeta::new(ctx.accounts.opener.key(), true),
                    AccountMeta::new(ctx.accounts.core.key(), false),
                ],
            ),
            &[
                ctx.accounts.opener.to_account_info(),
                ctx.accounts.core.to_account_info(),
            ],
        )?;

        emit!(ExpiryCrankRequested {
            incident_id: ctx.accounts.core.incident_id,
            task_id,
            execution_interval_millis,
            iterations,
        });
        Ok(())
    }

    /// Ephemeral rollup. Asks the scheduler to remove this incident's expiry task.
    ///
    /// Only the incident's opener may request it. The task exists to stop this incident
    /// hanging open, so letting a stranger cancel it would let a stranger keep it open.
    ///
    /// Like the schedule request, this returns once the request is accepted. Removal is a
    /// separate observation, and an incident's accounts must not be undelegated until it is
    /// observed: a task whose accounts have left the rollup fails on every remaining
    /// iteration.
    pub fn cancel_expiry_crank(ctx: Context<CancelExpiryCrank>) -> Result<()> {
        let task_id = expiry_task_id(&ctx.accounts.core);
        let data = bincode::serialize(&MagicBlockInstruction::CancelTask { task_id })
            .map_err(|_| error!(CoreError::CrankEncodingFailed))?;

        invoke(
            &Instruction::new_with_bytes(
                MAGIC_PROGRAM_ID,
                &data,
                vec![
                    AccountMeta::new(ctx.accounts.opener.key(), true),
                    AccountMeta::new(ctx.accounts.core.key(), false),
                ],
            ),
            &[
                ctx.accounts.opener.to_account_info(),
                ctx.accounts.core.to_account_info(),
            ],
        )?;

        emit!(ExpiryCrankCancellationRequested {
            incident_id: ctx.accounts.core.incident_id,
            task_id,
        });
        Ok(())
    }

    /// Ephemeral rollup. Overwrites the claim.
    ///
    /// Permissionless, and allowed only once the incident is terminal. Requiring a signature
    /// would let a responder who dislikes the outcome strand the evidence inside the rollup
    /// by never calling this.
    pub fn scrub_claim(ctx: Context<ScrubClaim>) -> Result<()> {
        require!(
            ctx.accounts.core.status.is_terminal(),
            CoreError::IncidentNotTerminal
        );
        ctx.accounts.claim.scrub();
        Ok(())
    }

    /// Ephemeral rollup. Overwrites one member's decision.
    pub fn scrub_attestation(ctx: Context<ScrubAttestation>) -> Result<()> {
        require!(
            ctx.accounts.core.status.is_terminal(),
            CoreError::IncidentNotTerminal
        );
        ctx.accounts.attestation.scrub();
        Ok(())
    }

    /// Ephemeral rollup. Closes the claim's permission.
    ///
    /// Gated on the scrub, because closing a permission makes the account readable again on
    /// that rollup. Doing it while the evidence is still there would publish it.
    pub fn close_claim_permission(ctx: Context<CloseClaimPermission>) -> Result<()> {
        ctx.accounts.claim.may_leave_the_private_runtime()?;
        let core = ctx.accounts.claim.incident;
        let seeds = [
            incident::CLAIM_SEED,
            core.as_ref(),
            &[ctx.accounts.claim.bump],
        ];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.claim.to_account_info(),
            permissioned_account: ctx.accounts.claim.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.claim.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&seeds])?;
        Ok(())
    }

    /// Ephemeral rollup. Closes one attestation's permission, once it is scrubbed.
    pub fn close_attestation_permission(ctx: Context<AttestationPermission>) -> Result<()> {
        ctx.accounts.attestation.may_leave_the_private_runtime()?;
        let attestation = &ctx.accounts.attestation;
        let core = attestation.incident;
        let member = attestation.member;
        let seeds = [
            incident::ATTESTATION_SEED,
            core.as_ref(),
            member.as_ref(),
            &[attestation.bump],
        ];
        CloseEphemeralPermissionCpi {
            payer: attestation.to_account_info(),
            permissioned_account: attestation.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: attestation.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&seeds])?;
        Ok(())
    }

    /// Ephemeral rollup. Releases the whole incident back to the base layer.
    ///
    /// Core, claim, and every attestation commit and undelegate in one intent. Every private
    /// account passes the zeroization gate first, on its own bytes. The core needs no gate
    /// because it never held anything private.
    pub fn release_incident<'info>(
        ctx: Context<'info, ReleaseIncident<'info>>,
        incident_id: u64,
        covenant: Pubkey,
    ) -> Result<()> {
        let _ = (incident_id, covenant);
        let accounts = gated_exit_accounts(&ctx, true)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&accounts)
        .build_and_invoke()?;
        Ok(())
    }

    /// Ephemeral rollup. Commits the incident without undelegating it.
    ///
    /// Gated identically to the releasing path. A commit copies an account's bytes to the
    /// base layer, so an unscrubbed commit publishes exactly what an unscrubbed undelegation
    /// would. Both doors, one lock.
    pub fn commit_incident<'info>(
        ctx: Context<'info, ReleaseIncident<'info>>,
        incident_id: u64,
        covenant: Pubkey,
    ) -> Result<()> {
        let _ = (incident_id, covenant);
        let accounts = gated_exit_accounts(&ctx, false)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&accounts)
        .build_and_invoke()?;
        Ok(())
    }

    /// Returns this program's build fingerprint.
    ///
    /// Touches no account and changes no state, so it is safe to simulate anywhere. Run it
    /// against base and against the ER before collecting any proof artifact: if the two
    /// answers differ, the ER is serving a cached clone and nothing it produces is evidence
    /// about the current build.
    pub fn build_info(_ctx: Context<BuildInfo>) -> Result<()> {
        msg!("VINCT_BUILD_FINGERPRINT={}", BUILD_FINGERPRINT);
        anchor_lang::solana_program::program::set_return_data(BUILD_FINGERPRINT.as_bytes());
        Ok(())
    }

    /// Base layer. Creates the delegatable operation account for one settlement.
    ///
    /// This is the account the ER writes to and the committor commits. It carries no
    /// private data: the private incident state is a different account, delegated
    /// separately, and scrubbed before it ever commits.
    pub fn initialize_operation(
        ctx: Context<InitializeOperation>,
        operation_id: [u8; 32],
        expected_action_count: u16,
    ) -> Result<()> {
        require!(operation_id != [0u8; 32], CoreError::ZeroOperationId);
        require!(
            expected_action_count > 0 && expected_action_count <= MAX_COHORT_ACTIONS,
            CoreError::InvalidActionCount
        );
        let operation = &mut ctx.accounts.operation;
        operation.operation_id = operation_id;
        operation.certificate = ctx.accounts.certificate.key();
        operation.authority = ctx.accounts.authority.key();
        operation.expected_action_count = expected_action_count;
        operation.scheduled = false;
        operation.scheduled_at_slot = 0;
        operation.attempt_count = 0;
        operation.bump = ctx.bumps.operation;
        Ok(())
    }

    /// Base layer. Delegates the operation account to the ephemeral rollup.
    ///
    /// Routing rule this deliberately does not break: delegation always happens on base,
    /// and the ER endpoint is discovered afterwards rather than assumed. Nothing in this
    /// program names a regional endpoint.
    pub fn delegate_operation(
        ctx: Context<DelegateOperation>,
        operation_id: [u8; 32],
    ) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref();
        ctx.accounts.delegate_operation(
            &ctx.accounts.authority,
            &[OPERATION_SEED, operation_id.as_ref()],
            DelegateConfig {
                validator: validator.map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Ephemeral rollup. Schedules the whole settlement cohort in one intent bundle.
    ///
    /// This is the seam the product rests on, and the honest reading of what it does is
    /// narrow: it commits the operation account, undelegates it, and asks the committor to
    /// run four base-layer actions afterwards. A successful return here means the intent was
    /// accepted. It does not mean any action ran, and it never will.
    ///
    /// Within one attempted base transaction the commit and its actions are atomic. If a
    /// BaseAction fails, the committor may remove every BaseAction in that transaction
    /// strategy and retry the remaining commit work, which is why `COMMIT_WITHOUT_ACTIONS`
    /// is a state this product models rather than an edge case it hopes to avoid.
    ///
    /// `remaining_accounts` carries the per-adapter accounts in repeating groups of
    /// [`ACCOUNTS_PER_ADAPTER_ACTION`]: capability, protocol state, adapter receipt, adapter
    /// signer. The certificate and the adapter's target program are shared and declared.
    pub fn schedule_settlement_cohort<'info>(
        ctx: Context<'info, ScheduleSettlementCohort<'info>>,
        args: ScheduleCohortArgs,
    ) -> Result<()> {
        // Decoded by hand because the account is untyped. Owner and discriminator are
        // checked explicitly, so nothing is trusted that a typed account would have checked.
        let mut operation = SettlementOperation::load(&ctx.accounts.operation)?;
        require!(!operation.scheduled, CoreError::CohortAlreadyScheduled);
        require!(
            operation.operation_id == args.operation_id,
            CoreError::OperationMismatch
        );
        require_keys_eq!(
            operation.certificate,
            ctx.accounts.certificate.key(),
            CoreError::CertificateMismatch
        );

        let adapter_action_count = usize::from(args.adapter_action_count);
        require!(
            adapter_action_count > 0 && adapter_action_count < usize::from(MAX_COHORT_ACTIONS),
            CoreError::InvalidActionCount
        );
        require!(
            ctx.remaining_accounts.len() == adapter_action_count * ACCOUNTS_PER_ADAPTER_ACTION,
            CoreError::AdapterAccountCountMismatch
        );
        require!(
            usize::from(operation.expected_action_count) == adapter_action_count + 1,
            CoreError::InvalidActionCount
        );

        let operation_id = operation.operation_id;
        let certificate = ctx.accounts.certificate.key();
        let adapter_target = ctx.accounts.adapter_target_program.key();

        let mut actions: Vec<CallHandler<'info>> = Vec::with_capacity(adapter_action_count + 1);

        for index in 0..adapter_action_count {
            let base = index * ACCOUNTS_PER_ADAPTER_ACTION;
            let capability = &ctx.remaining_accounts[base];
            let protocol_state = &ctx.remaining_accounts[base + 1];
            let receipt = &ctx.remaining_accounts[base + 2];
            let adapter_signer = &ctx.remaining_accounts[base + 3];

            // The adapter's declared account order. It is reproduced here rather than
            // derived, because the adapter recomputes a commitment over exactly this order
            // and will refuse anything else. Both sides changing together is the point.
            let accounts = vec![
                short_meta(certificate, false),
                short_meta(capability.key(), true),
                short_meta(protocol_state.key(), true),
                short_meta(receipt.key(), true),
                short_meta(adapter_signer.key(), false),
                short_meta(adapter_target, false),
            ];

            actions.push(CallHandler {
                destination_program: ctx.accounts.adapter_program.key(),
                accounts,
                args: ActionArgs::new(EXECUTE_BOUNDED_ACTION_DISCRIMINATOR.to_vec()),
                escrow_authority: ctx.accounts.payer.to_account_info(),
                compute_units: args.adapter_compute_units,
            });
        }

        // The final action. It runs last so a reconciler that sees this receipt knows the
        // cohort claimed completion, and its absence alongside present adapter effects is
        // exactly the partial observation that blocks automated recovery.
        let mut settlement_data = Vec::with_capacity(8 + 32 + 2);
        settlement_data.extend_from_slice(&FINALIZE_SETTLEMENT_DISCRIMINATOR);
        settlement_data.extend_from_slice(&operation_id);
        settlement_data.extend_from_slice(&args.adapter_action_count.to_le_bytes());

        actions.push(CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                short_meta(ctx.accounts.settlement_receipt.key(), true),
                short_meta(certificate, false),
            ],
            args: ActionArgs::new(settlement_data),
            escrow_authority: ctx.accounts.payer.to_account_info(),
            compute_units: args.settlement_compute_units,
        });

        // The state change is written before the intent is built, and written by hand.
        //
        // The committed bytes must already say the cohort was scheduled, otherwise the
        // account landing on base would claim it never was. And nothing may write to this
        // account after `commit_and_undelegate` takes it, which is why the context holds it
        // untyped: Anchor's automatic write-back would happen after the CPI and Devnet
        // rejects it with `ExternalAccountDataModified`.
        operation.scheduled = true;
        operation.scheduled_at_slot = Clock::get()?.slot;
        operation.attempt_count = operation
            .attempt_count
            .checked_add(1)
            .ok_or(CoreError::AttemptCountOverflow)?;
        operation.store(&ctx.accounts.operation)?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.operation.to_account_info()])
        .add_post_commit_actions(actions)
        .build_and_invoke()?;

        emit!(CohortScheduled {
            operation_id,
            adapter_action_count: args.adapter_action_count,
        });
        Ok(())
    }

    /// Marks the operation's settlement receipt final.
    ///
    /// The last action in a cohort. Writing this receipt is what a reconciler looks for as
    /// the cohort's own claim of completion, and it is deliberately not sufficient on its
    /// own: `SETTLED` additionally requires every adapter receipt and every target effect to
    /// have been observed independently.
    ///
    /// Idempotent. A second finalization is refused so a duplicate delivery is visible.
    pub fn finalize_settlement(
        ctx: Context<FinalizeSettlement>,
        operation_id: [u8; 32],
        observed_action_count: u16,
    ) -> Result<()> {
        let receipt = &mut ctx.accounts.settlement_receipt;
        require!(
            receipt.operation_id == operation_id,
            CoreError::OperationMismatch
        );
        require!(!receipt.finalized, CoreError::SettlementAlreadyFinalized);

        let certificate = &ctx.accounts.certificate;
        require!(
            certificate.operation_id == operation_id,
            CoreError::OperationMismatch
        );
        require_keys_eq!(
            receipt.certificate,
            certificate.key(),
            CoreError::CertificateMismatch
        );

        receipt.finalized = true;
        receipt.observed_action_count = observed_action_count;
        receipt.finalized_at_slot = Clock::get()?.slot;

        emit!(SettlementFinalized {
            operation_id,
            observed_action_count,
        });
        Ok(())
    }
}

/// Builds a `ShortAccountMeta` from a key and its writability.
///
/// A Magic Action carries only the key and the writable flag; signer-ness is decided by the
/// runtime, and the escrow accounts the `#[action]` macro injects are appended by the SDK
/// rather than listed here.
fn short_meta(key: Pubkey, is_writable: bool) -> ShortAccountMeta {
    ShortAccountMeta {
        pubkey: key.to_bytes().into(),
        is_writable,
    }
}

/// The adapter's `execute_bounded_action` discriminator.
///
/// Hardcoded rather than imported, because the core deliberately takes no build-time
/// dependency on the adapter. `the_scheduler_uses_the_adapters_real_discriminator` in the
/// program tests asserts it still matches the adapter's IDL.
pub const EXECUTE_BOUNDED_ACTION_DISCRIMINATOR: [u8; 8] = [174, 108, 103, 144, 85, 165, 195, 31];

/// This program's own `finalize_settlement` discriminator.
pub const FINALIZE_SETTLEMENT_DISCRIMINATOR: [u8; 8] = [220, 72, 152, 119, 178, 196, 25, 170];

/// Upper bound on one cohort. Three adapter actions plus one settlement receipt is the
/// reference shape; the bound exists so a malformed request cannot ask for an unbounded
/// number of `CallHandler`s.
pub const MAX_COHORT_ACTIONS: u16 = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScheduleCohortArgs {
    /// The operation being settled. Supplied rather than read from the account, because the
    /// account is decoded by hand and its seeds must be checked before it is trusted.
    pub operation_id: [u8; 32],
    /// How many adapter actions precede the settlement action.
    pub adapter_action_count: u16,
    /// Per-action compute budget for each adapter action.
    pub adapter_compute_units: u32,
    /// Compute budget for the final settlement action.
    pub settlement_compute_units: u32,
}

/// Moves enough lamports into a soon-to-be-delegated account to pay for its own ER-local
/// permission.
///
/// A delegated account pays that rent itself once it is inside the rollup, and there is no
/// way to top it up from base afterwards, so the funding has to happen before delegation.
fn fund_for_permission<'info>(
    system_program: &Program<'info, System>,
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    permission_members: usize,
) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.key(),
            anchor_lang::system_program::Transfer {
                from: from.to_account_info(),
                to: to.clone(),
            },
        ),
        ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(
            permission_members,
        ) as u32),
    )
}

/// Reads a core account held untyped, checking its owner before its bytes.
fn read_core(account: &UncheckedAccount) -> Result<incident::IncidentCore> {
    require_keys_eq!(*account.owner, crate::ID, CoreError::IncidentWrongOwner);
    let data = account.try_borrow_data()?;
    let core = incident::IncidentCore::try_deserialize(&mut &data[..])
        .map_err(|_| error!(CoreError::IncidentAccountMalformed))?;
    require!(
        core.version == incident::INCIDENT_SCHEMA_VERSION,
        CoreError::UnsupportedSchemaVersion
    );
    Ok(core)
}

/// Reads one ballot account, checked before it is believed.
///
/// Owner before bytes, then schema version, then the incident it claims to belong to, then
/// its own canonical address derived from that incident and the member it names. The address
/// check is what makes the `member` field trustworthy: a ballot cannot be relabelled, because
/// relabelling it changes the address it would have to live at.
fn read_ballot(info: &AccountInfo, core_key: Pubkey) -> Result<incident::MemberAttestation> {
    require_keys_eq!(*info.owner, crate::ID, CoreError::IncidentWrongOwner);
    let attestation =
        incident::MemberAttestation::try_deserialize(&mut &info.try_borrow_data()?[..])
            .map_err(|_| error!(CoreError::IncidentAccountMalformed))?;
    require!(
        attestation.version == incident::INCIDENT_SCHEMA_VERSION,
        CoreError::UnsupportedSchemaVersion
    );
    require_keys_eq!(attestation.incident, core_key, CoreError::OperationMismatch);

    let (expected_address, _) = Pubkey::find_program_address(
        &[
            incident::ATTESTATION_SEED,
            core_key.as_ref(),
            attestation.member.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(info.key(), expected_address, CoreError::OperationMismatch);
    Ok(attestation)
}

/// Reconstructs the frozen ballot set from `remaining_accounts` and proves it is the set.
///
/// The supplied list is not trusted for deserializing, and it is not trusted positionally
/// either. Every ballot is validated on its own, the members must arrive strictly ascending,
/// and the commitment recomputed over them has to equal the one frozen at open.
///
/// That single equality carries most of the invariants at once. A missing member, an extra
/// one, a duplicate, a ballot belonging to another incident, and a ballot relabelled to
/// another member each either change the digest or fail an earlier check. Ascending order
/// makes the digest a function of the set rather than of the caller's arrangement, so a
/// reordered list is refused rather than quietly producing a different answer.
fn reconstruct_frozen_ballots(
    core: &incident::IncidentCore,
    core_key: Pubkey,
    supplied: &[AccountInfo],
) -> Result<Vec<incident::MemberAttestation>> {
    require!(
        supplied.len() == usize::from(core.member_count),
        CoreError::AttestationCountMismatch
    );

    let mut ballots: Vec<incident::MemberAttestation> = Vec::with_capacity(supplied.len());
    for info in supplied.iter() {
        let ballot = read_ballot(info, core_key)?;
        require!(ballot.state.may_be_counted(), CoreError::BallotNotCountable);
        if let Some(previous) = ballots.last() {
            require!(
                previous.member.to_bytes() < ballot.member.to_bytes(),
                CoreError::MemberSetNotAscending
            );
        }
        ballots.push(ballot);
    }

    let members: Vec<Pubkey> = ballots.iter().map(|b| b.member).collect();
    require!(
        incident::member_set_commitment(&members)? == core.member_set_hash,
        CoreError::BallotSetDoesNotMatchSnapshot
    );
    Ok(ballots)
}

/// Moves an incident from `Collecting` to the terminal status its tally implies.
///
/// One function, used by the caller-driven `certify_incident` and by the scheduled
/// `expire_incident`, because two copies of a terminal transition are two chances for a
/// crank-expired incident and a manually-expired one to disagree about what happened.
///
/// The caller decides *whether* to transition. This decides *what to*.
fn settle_terminal(core: &mut incident::IncidentCore, tally: &incident::Tally, slot: u64) {
    core.approval_count_after_terminal = tally.approvals;
    core.rejection_count_after_terminal = tally.rejections;
    core.certified_at_slot = slot;

    // The operation identity, derived from the frozen snapshot by the same function the
    // reference model and the standalone verifier use. Three implementations of one digest
    // would be three chances to disagree about which operation a certificate authorises.
    //
    // The certification slot is the nonce. It is drawn once, at the only moment that can
    // produce a certificate for this incident, and it is public by the time anyone can read
    // it.
    core.operation_id =
        vinct_types::action::operation_id(&vinct_types::action::OperationInputsV1 {
            cluster_genesis_hash: core.cluster_genesis_hash,
            covenant: vinct_types::Address::from(core.covenant.to_bytes()),
            circle_epoch: core.circle_epoch,
            incident_id: core.incident_id,
            policy_id: core.policy_id,
            member_set_hash: core.member_set_hash,
            action_bundle_template_hash: core.action_bundle_template_hash,
            certificate_nonce: slot,
        });

    // Three terminal outcomes, matching the reference model's. The rejected case is recorded
    // distinctly rather than folded into expiry, so the covenant can tell a blocked incident
    // from one nobody answered. It is only ever reached at or after the deadline, so naming it
    // costs no timing information.
    core.status = if tally.meets(core) {
        incident::IncidentStatus::CertifiedPendingSettlement
    } else if tally.rejections > core.maximum_rejections {
        incident::IncidentStatus::RejectedByThreshold
    } else {
        incident::IncidentStatus::Expired
    };

    emit!(IncidentCertified {
        incident_id: core.incident_id,
        status: core.status,
        approval_count: core.approval_count_after_terminal,
        rejection_count: core.rejection_count_after_terminal,
    });
}

/// This incident's scheduler task ID.
///
/// A task ID is global to a scheduler instance and is not part of a key, so a small counter
/// is a collision waiting for a second application. This is a domain-separated digest of the
/// cluster, the covenant, and the incident, folded into the signed 64-bit integer the
/// scheduler takes.
///
/// Derived rather than stored, so re-requesting an incident's task lands on the same ID and
/// becomes an update rather than a second task, and so cancellation needs no lookup.
///
/// The sign bit is cleared instead of the value being reinterpreted. `i64::MIN` has no
/// positive counterpart, so negating would have one input with no valid output, and reserving
/// negative IDs costs one bit of a 64-bit space that is already far larger than the number of
/// incidents any covenant will open.
pub fn expiry_task_id(core: &incident::IncidentCore) -> i64 {
    let mut preimage = Vec::with_capacity(EXPIRY_TASK_DOMAIN.len() + 32 + 32 + 8);
    preimage.extend_from_slice(EXPIRY_TASK_DOMAIN);
    preimage.extend_from_slice(&core.cluster_genesis_hash);
    preimage.extend_from_slice(core.covenant.as_ref());
    preimage.extend_from_slice(&core.incident_id.to_le_bytes());

    let digest: [u8; 32] = {
        use sha2::Digest;
        sha2::Sha256::digest(&preimage).into()
    };
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    i64::from_le_bytes(head) & i64::MAX
}

/// The account list for an exit, with every private account gated on its own bytes.
///
/// One helper for both doors, because a gate applied to one exit and not the other is the
/// shape this kind of bug takes. `require_terminal` is the only difference: a release ends
/// the incident's life on the rollup and must not run mid-flight, while a commit is a
/// checkpoint.
///
/// The accounts are held untyped and read by hand for the reason recorded in D-0029:
/// Anchor's automatic write-back lands after `commit_and_undelegate` has taken the account,
/// and Devnet rejects that.
fn gated_exit_accounts<'info>(
    ctx: &Context<'info, ReleaseIncident<'info>>,
    require_terminal: bool,
) -> Result<Vec<AccountInfo<'info>>> {
    let core = read_core(&ctx.accounts.core)?;
    if require_terminal {
        require!(core.status.is_terminal(), CoreError::IncidentNotTerminal);
    }

    let core_key = ctx.accounts.core.key();
    require_keys_eq!(
        *ctx.accounts.claim.owner,
        crate::ID,
        CoreError::IncidentWrongOwner
    );
    let claim =
        incident::IncidentClaim::try_deserialize(&mut &ctx.accounts.claim.try_borrow_data()?[..])
            .map_err(|_| error!(CoreError::IncidentAccountMalformed))?;
    require_keys_eq!(claim.incident, core_key, CoreError::OperationMismatch);
    claim.may_leave_the_private_runtime()?;

    // The exit checks the whole family. A release that took only some of the ballots would
    // leave the rest delegated with nothing left to release them.
    require!(
        ctx.remaining_accounts.len() == usize::from(core.member_count),
        CoreError::AttestationCountMismatch
    );
    for info in ctx.remaining_accounts.iter() {
        read_ballot(info, core_key)?.may_leave_the_private_runtime()?;
    }

    let mut accounts = vec![
        ctx.accounts.core.to_account_info(),
        ctx.accounts.claim.to_account_info(),
    ];
    accounts.extend(ctx.remaining_accounts.iter().cloned());
    Ok(accounts)
}

/// Checks that a signer is the opener recorded on a core account held untyped.
fn require_opener_of_core(account: &UncheckedAccount, signer: Pubkey) -> Result<()> {
    let core = read_core(account)?;
    require_keys_eq!(core.opener, signer, CoreError::NotTheOpener);
    Ok(())
}

// ---------------------------------------------------------------------------
// Covenant contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: covenant::CreateCovenantArgs)]
pub struct CreateCovenant<'info> {
    #[account(
        init,
        payer = steward,
        space = 8 + covenant::Covenant::SIZE,
        seeds = [
            covenant::COVENANT_SEED,
            steward.key().as_ref(),
            &args.covenant_id.to_le_bytes()
        ],
        bump
    )]
    pub covenant: Account<'info, covenant::Covenant>,
    #[account(mut)]
    pub steward: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(protocol: Pubkey)]
pub struct AddCovenantMember<'info> {
    #[account(mut, has_one = steward @ CoreError::NotTheSteward)]
    pub covenant: Account<'info, covenant::Covenant>,
    #[account(
        init,
        payer = steward,
        space = 8 + covenant::CovenantMember::SIZE,
        seeds = [
            covenant::COVENANT_MEMBER_SEED,
            covenant.key().as_ref(),
            protocol.as_ref()
        ],
        bump
    )]
    pub member: Account<'info, covenant::CovenantMember>,
    #[account(mut)]
    pub steward: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Ratifying or arming one membership.
///
/// The protocol authority signs its own account. The steward is not in this context at all,
/// which is the point: convening a circle is not the same as speaking for it.
#[derive(Accounts)]
pub struct CovenantMemberAction<'info> {
    #[account(mut)]
    pub covenant: Account<'info, covenant::Covenant>,
    #[account(
        mut,
        has_one = protocol @ CoreError::NotTheProtocolAuthority,
        constraint = member.covenant == covenant.key() @ CoreError::OperationMismatch,
        seeds = [
            covenant::COVENANT_MEMBER_SEED,
            covenant.key().as_ref(),
            protocol.key().as_ref()
        ],
        bump = member.bump
    )]
    pub member: Account<'info, covenant::CovenantMember>,
    pub protocol: Signer<'info>,
}

/// Freezing the member set.
///
/// Every member account arrives in `remaining_accounts`, strictly ascending by protocol
/// authority. Permissionless: every signature that matters was collected already.
#[derive(Accounts)]
pub struct RatifyCovenant<'info> {
    #[account(
        mut,
        seeds = [
            covenant::COVENANT_SEED,
            covenant.steward.as_ref(),
            &covenant.covenant_id.to_le_bytes()
        ],
        bump = covenant.bump
    )]
    pub covenant: Account<'info, covenant::Covenant>,
}

#[derive(Accounts)]
pub struct ArmCovenant<'info> {
    #[account(
        mut,
        seeds = [
            covenant::COVENANT_SEED,
            covenant.steward.as_ref(),
            &covenant.covenant_id.to_le_bytes()
        ],
        bump = covenant.bump
    )]
    pub covenant: Account<'info, covenant::Covenant>,
}

// ---------------------------------------------------------------------------
// Private incident contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(incident_id: u64, covenant: Pubkey)]
pub struct InitializeIncident<'info> {
    #[account(
        init,
        payer = opener,
        space = 8 + incident::IncidentCore::SIZE,
        seeds = [incident::INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
        bump
    )]
    pub core: Account<'info, incident::IncidentCore>,
    #[account(
        seeds = [
            crate::covenant::COVENANT_SEED,
            covenant_account.steward.as_ref(),
            &covenant_account.covenant_id.to_le_bytes()
        ],
        bump = covenant_account.bump
    )]
    pub covenant_account: Account<'info, covenant::Covenant>,
    /// The opener's own membership, which is what makes them a responder rather than a
    /// passer-by. Seed-derived from the covenant and the signer, so it cannot be someone
    /// else's.
    #[account(
        constraint = opener_membership.covenant == covenant_account.key() @ CoreError::OperationMismatch,
        seeds = [
            crate::covenant::COVENANT_MEMBER_SEED,
            covenant_account.key().as_ref(),
            opener.key().as_ref()
        ],
        bump = opener_membership.bump
    )]
    pub opener_membership: Account<'info, covenant::CovenantMember>,
    #[account(mut)]
    pub opener: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeClaim<'info> {
    #[account(has_one = opener @ CoreError::NotTheOpener)]
    pub core: Account<'info, incident::IncidentCore>,
    #[account(
        init,
        payer = opener,
        space = 8 + incident::IncidentClaim::SIZE,
        seeds = [incident::CLAIM_SEED, core.key().as_ref()],
        bump
    )]
    pub claim: Account<'info, incident::IncidentClaim>,
    #[account(mut)]
    pub opener: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(member: Pubkey)]
pub struct InitializeAttestation<'info> {
    #[account(has_one = opener @ CoreError::NotTheOpener)]
    pub core: Account<'info, incident::IncidentCore>,
    /// The member's covenant membership. Seed-derived from the covenant this incident froze
    /// and the member the ballot is for, so a ballot cannot be created for an outsider.
    #[account(
        seeds = [
            crate::covenant::COVENANT_MEMBER_SEED,
            core.covenant.as_ref(),
            member.as_ref()
        ],
        bump = membership.bump
    )]
    pub membership: Account<'info, covenant::CovenantMember>,
    #[account(
        init,
        payer = opener,
        space = 8 + incident::MemberAttestation::SIZE,
        seeds = [incident::ATTESTATION_SEED, core.key().as_ref(), member.as_ref()],
        bump
    )]
    pub attestation: Account<'info, incident::MemberAttestation>,
    #[account(mut)]
    pub opener: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(incident_id: u64, covenant: Pubkey)]
pub struct DelegateIncident<'info> {
    pub opener: Signer<'info>,
    /// CHECK: delegated by the delegation program; seeds are checked here and the opener is
    /// checked by hand in the handler.
    #[account(
        mut,
        del,
        seeds = [incident::INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
        bump
    )]
    pub core: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator, checked by the delegation program. Pinning is how
    /// an incident reaches the TEE-backed rollup rather than whichever region the router
    /// would otherwise pick.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(core: Pubkey)]
pub struct DelegateClaim<'info> {
    pub opener: Signer<'info>,
    /// CHECK: delegated by the delegation program; the opener is checked against this
    /// account's own bytes in the handler.
    #[account(mut, del, seeds = [incident::CLAIM_SEED, core.as_ref()], bump)]
    pub claim: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(core: Pubkey, member: Pubkey)]
pub struct DelegateAttestation<'info> {
    pub opener: Signer<'info>,
    /// CHECK: delegated by the delegation program; the opener is checked against this
    /// account's own bytes in the handler.
    #[account(
        mut,
        del,
        seeds = [incident::ATTESTATION_SEED, core.as_ref(), member.as_ref()],
        bump
    )]
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator.
    pub validator: Option<UncheckedAccount<'info>>,
}

/// Create and update for the claim's permission.
///
/// The opener signs, because these two instructions decide who may read the evidence. The
/// permission program will only accept the claim PDA as the permission's authority, which
/// protects the permission from that side and says nothing about who may ask this program to
/// make the call. See docs/decision-log.md D-0039.
#[derive(Accounts)]
pub struct ClaimPermissionAuthority<'info> {
    #[account(mut, has_one = opener @ CoreError::NotTheOpener)]
    pub claim: Account<'info, incident::IncidentClaim>,
    pub opener: Signer<'info>,
    /// CHECK: the permission PDA, owned and validated by the permission program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, claim.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: the ephemeral rent vault, address-checked.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: the magic program, address-checked.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: the permission program, address-checked.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// Closing the claim's permission.
///
/// No signer, deliberately. It is gated on the scrub, and a scrubbed claim has nothing left
/// to expose, so requiring a signature would only give a responder a way to strand it.
#[derive(Accounts)]
pub struct CloseClaimPermission<'info> {
    #[account(mut)]
    pub claim: Account<'info, incident::IncidentClaim>,
    /// CHECK: the permission PDA.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, claim.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// An attestation's permission, for both create and close.
///
/// No signer and no member argument. The single member is read off the account, so there is
/// nothing a caller could pass that would put a second reader on someone's ballot, and
/// nothing they could withhold that would leave one unprotected.
#[derive(Accounts)]
pub struct AttestationPermission<'info> {
    #[account(mut)]
    pub attestation: Account<'info, incident::MemberAttestation>,
    /// CHECK: the permission PDA.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, attestation.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// Opening.
///
/// Every ballot account arrives in `remaining_accounts`, in the same ascending order as the
/// member list in the arguments, so the frozen commitment is checked against accounts that
/// demonstrably exist.
#[derive(Accounts)]
pub struct OpenIncident<'info> {
    #[account(
        mut,
        has_one = opener @ CoreError::NotTheOpener,
        seeds = [
            incident::INCIDENT_SEED,
            core.covenant.as_ref(),
            &core.incident_id.to_le_bytes()
        ],
        bump = core.bump
    )]
    pub core: Account<'info, incident::IncidentCore>,
    pub opener: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitPrivateClaim<'info> {
    pub core: Account<'info, incident::IncidentCore>,
    #[account(mut, constraint = claim.incident == core.key() @ CoreError::OperationMismatch)]
    pub claim: Account<'info, incident::IncidentClaim>,
    pub responder: Signer<'info>,
}

/// One member submitting their own decision.
///
/// The signer selects the account through the PDA seeds, so there is no member argument to
/// spoof and no path by which one member's key reaches another member's attestation.
#[derive(Accounts)]
pub struct SubmitSealedAttestation<'info> {
    pub core: Account<'info, incident::IncidentCore>,
    #[account(
        mut,
        seeds = [incident::ATTESTATION_SEED, core.key().as_ref(), member.key().as_ref()],
        bump = attestation.bump
    )]
    pub attestation: Account<'info, incident::MemberAttestation>,
    pub member: Signer<'info>,
}

#[derive(Accounts)]
pub struct QuarantineMember<'info> {
    #[account(has_one = opener @ CoreError::NotTheOpener)]
    pub core: Account<'info, incident::IncidentCore>,
    #[account(
        mut,
        constraint = attestation.incident == core.key() @ CoreError::OperationMismatch
    )]
    pub attestation: Account<'info, incident::MemberAttestation>,
    pub opener: Signer<'info>,
}

/// Certification.
///
/// Permissionless on purpose. An incident that has met its threshold, or run out its window,
/// must be settleable by anyone, or a responder who dislikes the outcome could leave it
/// hanging. Every attestation account arrives in `remaining_accounts`.
#[derive(Accounts)]
pub struct CertifyIncident<'info> {
    /// Seed-constrained so a caller cannot substitute a different incident's core and settle
    /// this one's ballots against someone else's threshold.
    #[account(
        mut,
        seeds = [
            incident::INCIDENT_SEED,
            core.covenant.as_ref(),
            &core.incident_id.to_le_bytes()
        ],
        bump = core.bump
    )]
    pub core: Account<'info, incident::IncidentCore>,
}

/// The scheduled handler's accounts.
///
/// No signer, and no payer. The scheduled transaction is signed by the validator identity, so
/// there is no caller here to authenticate and nothing to charge. Seed-constrained for the
/// same reason certification is: a substituted core would settle this incident's ballots
/// against another's threshold.
///
/// remaining_accounts: the frozen ballot set, in canonical order.
#[derive(Accounts)]
pub struct ExpireIncident<'info> {
    #[account(
        mut,
        seeds = [
            incident::INCIDENT_SEED,
            core.covenant.as_ref(),
            &core.incident_id.to_le_bytes()
        ],
        bump = core.bump
    )]
    pub core: Account<'info, incident::IncidentCore>,
}

/// remaining_accounts: the frozen ballot set, in canonical order. It is validated here and
/// then baked into the scheduled instruction, so this is the last moment it can be checked.
#[derive(Accounts)]
pub struct RequestExpiryCrank<'info> {
    /// Writable, and not written to.
    ///
    /// The magic program's `ScheduleTask` takes the task context account as writable, and a CPI
    /// cannot hand out a privilege the calling instruction does not hold. Declaring this
    /// read-only produces `PrivilegeEscalation` at the CPI rather than anything that names the
    /// cause, which is worth a sentence here because the next person to hit it will be looking
    /// at a scheduling failure with no logs.
    #[account(
        mut,
        seeds = [
            incident::INCIDENT_SEED,
            core.covenant.as_ref(),
            &core.incident_id.to_le_bytes()
        ],
        bump = core.bump
    )]
    pub core: Account<'info, incident::IncidentCore>,
    /// The opener, who becomes the task's authority.
    ///
    /// The scheduler takes the signer of the schedule request as the task's owner, and only
    /// that owner may cancel or replace it later. Letting anyone request the task would
    /// therefore hand a stranger the only key that can remove it, and a first run of this
    /// phase did exactly that: a payer scheduled, the opener cancelled, the cancel request was
    /// accepted, and the task ran all 32 of its iterations anyway. Wrong-authority
    /// cancellation is a silent no-op, not a refusal.
    #[account(mut, address = core.opener @ CoreError::IncidentWrongOpener)]
    pub opener: Signer<'info>,
    /// CHECK: address-checked against the SDK constant; the magic program is native and owns
    /// no account this program reads.
    #[account(address = MAGIC_PROGRAM_ID @ CoreError::UnexpectedMagicProgram)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Only the opener may ask for the task to be removed.
///
/// The task is what stops this incident hanging open past its deadline. A stranger who could
/// cancel it could keep the incident alive indefinitely, which is the exact outcome the whole
/// phase exists to prevent.
#[derive(Accounts)]
pub struct CancelExpiryCrank<'info> {
    /// Writable for the same reason as in `RequestExpiryCrank`, and written to for none.
    #[account(
        mut,
        seeds = [
            incident::INCIDENT_SEED,
            core.covenant.as_ref(),
            &core.incident_id.to_le_bytes()
        ],
        bump = core.bump,
        has_one = opener @ CoreError::IncidentWrongOpener
    )]
    pub core: Account<'info, incident::IncidentCore>,
    #[account(mut)]
    pub opener: Signer<'info>,
    /// CHECK: address-checked against the SDK constant.
    #[account(address = MAGIC_PROGRAM_ID @ CoreError::UnexpectedMagicProgram)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ScrubClaim<'info> {
    pub core: Account<'info, incident::IncidentCore>,
    #[account(mut, constraint = claim.incident == core.key() @ CoreError::OperationMismatch)]
    pub claim: Account<'info, incident::IncidentClaim>,
}

#[derive(Accounts)]
pub struct ScrubAttestation<'info> {
    pub core: Account<'info, incident::IncidentCore>,
    #[account(
        mut,
        constraint = attestation.incident == core.key() @ CoreError::OperationMismatch
    )]
    pub attestation: Account<'info, incident::MemberAttestation>,
}

/// The exit, shared by the committing and the releasing path.
///
/// `#[commit]` appends `magic_program` and then `magic_context`. Every attestation follows in
/// `remaining_accounts`.
#[commit]
#[derive(Accounts)]
#[instruction(incident_id: u64, covenant: Pubkey)]
pub struct ReleaseIncident<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: read by hand with explicit owner and discriminator checks.
    ///
    /// Untyped for the reason recorded in D-0029: Anchor writes a typed `Account` back when
    /// the instruction ends, which lands after `commit_and_undelegate` has already taken the
    /// account into the intent, and Devnet rejects that as `ExternalAccountDataModified`.
    #[account(
        mut,
        seeds = [incident::INCIDENT_SEED, covenant.as_ref(), &incident_id.to_le_bytes()],
        bump
    )]
    pub core: UncheckedAccount<'info>,
    /// CHECK: read by hand; same reason as the core.
    #[account(mut, seeds = [incident::CLAIM_SEED, core.key().as_ref()], bump)]
    pub claim: UncheckedAccount<'info>,
}

#[event]
pub struct IncidentCertified {
    pub incident_id: u64,
    pub status: incident::IncidentStatus,
    pub approval_count: u8,
    pub rejection_count: u8,
}

/// Why a scheduled expiry did nothing.
///
/// Emitted rather than returned as an error, because every one of these is a normal outcome
/// for a task that fires on a cadence rather than on a condition. An operator watching a task
/// needs to tell "ran and had nothing to do" from "never ran", and without this they look
/// identical from outside.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExpirySkipReason {
    /// The incident had already reached a terminal status.
    AlreadyTerminal,
    /// The response window had not closed.
    WindowStillOpen,
    /// The ballot set did not reconstruct against the frozen commitment.
    BallotSetUnavailable,
}

#[event]
pub struct ExpirySkipped {
    pub incident_id: u64,
    pub reason: ExpirySkipReason,
}

#[event]
pub struct ExpiryCrankRequested {
    pub incident_id: u64,
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[event]
pub struct ExpiryCrankCancellationRequested {
    pub incident_id: u64,
    pub task_id: i64,
}
/// No accounts. `build_info` must stay callable on any runtime, including one whose state
/// this program has never touched.
#[derive(Accounts)]
pub struct BuildInfo {}

#[derive(Accounts)]
#[instruction(operation_id: [u8; 32])]
pub struct InitializeOperation<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + SettlementOperation::SIZE,
        seeds = [OPERATION_SEED, operation_id.as_ref()],
        bump
    )]
    pub operation: Account<'info, SettlementOperation>,
    #[account(
        seeds = [CERTIFICATE_SEED, operation_id.as_ref()],
        bump = certificate.bump,
        constraint = certificate.operation_id == operation_id @ CoreError::OperationMismatch
    )]
    pub certificate: Account<'info, IncidentCertificate>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(operation_id: [u8; 32])]
pub struct DelegateOperation<'info> {
    pub authority: Signer<'info>,
    /// CHECK: delegated by the delegation program; seeds are checked here
    #[account(mut, del, seeds = [OPERATION_SEED, operation_id.as_ref()], bump)]
    pub operation: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator, checked by the delegation program
    pub validator: Option<UncheckedAccount<'info>>,
}

/// The ER-side scheduling context.
///
/// `#[commit]` appends `magic_context` and `magic_program`. The destination programs are
/// declared because a Magic Action's destination must be present in the outer commit
/// context even though it is not one of the target instruction's data accounts.
#[commit]
#[derive(Accounts)]
#[instruction(args: ScheduleCohortArgs)]
pub struct ScheduleSettlementCohort<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: decoded and re-serialized by hand below, with explicit owner and
    /// discriminator checks.
    ///
    /// Deliberately untyped. A typed `Account` is written back by Anchor when the
    /// instruction ends, which lands *after* `commit_and_undelegate` has already taken the
    /// account into the intent. Devnet rejects that second write with
    /// `ExternalAccountDataModified`. The MagicBlock crank example documents the same
    /// pattern for the same reason. See docs/decision-log.md D-0029.
    #[account(mut, seeds = [OPERATION_SEED, args.operation_id.as_ref()], bump)]
    pub operation: UncheckedAccount<'info>,
    /// CHECK: read-only in every action; identity checked against the operation.
    pub certificate: UncheckedAccount<'info>,
    /// CHECK: writable in the settlement action's own account list.
    pub settlement_receipt: UncheckedAccount<'info>,
    /// CHECK: destination program for the adapter actions.
    pub adapter_program: UncheckedAccount<'info>,
    /// CHECK: the program each adapter will call. Shared across the adapter actions.
    pub adapter_target_program: UncheckedAccount<'info>,
    /// CHECK: destination program for the settlement action.
    #[account(address = crate::ID)]
    pub program_id: UncheckedAccount<'info>,
}

/// The delegated account whose commit carries the cohort.
#[account]
pub struct SettlementOperation {
    /// The operation.
    pub operation_id: [u8; 32],
    /// The certificate that authorised it.
    pub certificate: Pubkey,
    /// The key that created it.
    pub authority: Pubkey,
    /// How many actions the cohort is expected to contain, including the settlement action.
    pub expected_action_count: u16,
    /// Whether an intent bundle has been accepted for this operation.
    ///
    /// Records that an intent was *accepted*, never that anything settled. The distinction
    /// is the entire point of this account.
    pub scheduled: bool,
    /// Slot the intent was accepted on the ER.
    pub scheduled_at_slot: u64,
    /// How many scheduling attempts have been accepted.
    pub attempt_count: u16,
    /// PDA bump.
    pub bump: u8,
}

impl SettlementOperation {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 32 + 32 + 32 + 2 + 1 + 8 + 2 + 1;

    /// Decodes an untyped operation account, checking what a typed account would check.
    ///
    /// Owner and discriminator are verified here rather than assumed. Without the owner
    /// check any account with matching bytes would decode; without the discriminator check
    /// a different account type owned by this program would.
    pub fn load(info: &UncheckedAccount) -> Result<Self> {
        require_keys_eq!(*info.owner, crate::ID, CoreError::OperationWrongOwner);
        let data = info.try_borrow_data()?;
        require!(
            data.len() >= 8 + Self::SIZE,
            CoreError::OperationAccountMalformed
        );
        require!(
            &data[..8] == SettlementOperation::DISCRIMINATOR,
            CoreError::OperationWrongDiscriminator
        );
        let mut slice: &[u8] = &data[8..];
        SettlementOperation::deserialize(&mut slice)
            .map_err(|_| error!(CoreError::OperationAccountMalformed))
    }

    /// Writes the operation back into its account, in place.
    pub fn store(&self, info: &UncheckedAccount) -> Result<()> {
        let mut data = info.try_borrow_mut_data()?;
        require!(
            data.len() >= 8 + Self::SIZE,
            CoreError::OperationAccountMalformed
        );
        let mut cursor = &mut data[8..];
        self.serialize(&mut cursor)
            .map_err(|_| error!(CoreError::OperationAccountMalformed))
    }
}

#[event]
pub struct CohortScheduled {
    pub operation_id: [u8; 32],
    pub adapter_action_count: u16,
}

/// Publishing a certificate.
///
/// The incident core is the only source, so there are no arguments. It has to be back on the
/// base layer and owned by this program, which is true only after the release, and its own
/// seeds are constrained so a caller cannot present someone else's incident.
#[derive(Accounts)]
pub struct PublishCertificate<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + IncidentCertificate::SIZE,
        seeds = [CERTIFICATE_SEED, core.operation_id.as_ref()],
        bump
    )]
    pub certificate: Account<'info, IncidentCertificate>,
    #[account(
        seeds = [
            incident::INCIDENT_SEED,
            core.covenant.as_ref(),
            &core.incident_id.to_le_bytes()
        ],
        bump = core.bump
    )]
    pub core: Account<'info, incident::IncidentCore>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(operation_id: [u8; 32])]
pub struct InitializeSettlementReceipt<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + SettlementReceipt::SIZE,
        seeds = [SETTLEMENT_SEED, operation_id.as_ref()],
        bump
    )]
    pub settlement_receipt: Account<'info, SettlementReceipt>,
    #[account(
        seeds = [CERTIFICATE_SEED, operation_id.as_ref()],
        bump = certificate.bump,
        constraint = certificate.operation_id == operation_id @ CoreError::OperationMismatch
    )]
    pub certificate: Account<'info, IncidentCertificate>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// The Magic Action target.
///
/// `#[action]` appends `escrow_auth` and `escrow`, so a caller building the
/// `ShortAccountMeta` list supplies only the two accounts declared here. The macro's
/// `escrow_auth` is a non-mutable `UncheckedAccount`, which is why this instruction writes
/// to a receipt created earlier rather than creating one. See docs/decision-log.md D-0015.
#[action]
#[derive(Accounts)]
#[instruction(operation_id: [u8; 32])]
pub struct FinalizeSettlement<'info> {
    #[account(
        mut,
        seeds = [SETTLEMENT_SEED, operation_id.as_ref()],
        bump = settlement_receipt.bump
    )]
    pub settlement_receipt: Account<'info, SettlementReceipt>,
    #[account(
        seeds = [CERTIFICATE_SEED, operation_id.as_ref()],
        bump = certificate.bump
    )]
    pub certificate: Account<'info, IncidentCertificate>,
}

/// A published threshold certificate.
///
/// Field order mirrors `vinct_types::certificate::CertificateV1` so the canonical hash can
/// be recomputed from this account without a translation layer.
#[account]
pub struct IncidentCertificate {
    /// The key that published this certificate.
    pub issuing_authority: Pubkey,
    /// The cluster this certificate is valid on.
    pub cluster_genesis_hash: [u8; 32],
    /// The covenant that issued it.
    pub covenant: Pubkey,
    /// The frozen epoch.
    pub circle_epoch: u64,
    /// The incident.
    pub incident_id: u64,
    /// The policy.
    pub policy_id: [u8; 32],
    /// The frozen member set.
    pub member_set_hash: [u8; 32],
    /// The one action bundle this certificate authorises.
    pub action_bundle_hash: [u8; 32],
    /// The operation identity.
    pub operation_id: [u8; 32],
    /// The nonce drawn at certification.
    pub certificate_nonce: u64,
    /// Aggregate approvals. Never a per-member decision.
    pub approval_count: u8,
    /// Aggregate rejections.
    pub rejection_count: u8,
    /// Slot the threshold was reached.
    pub certified_at_slot: u64,
    /// Slot after which this certificate may no longer settle.
    pub expires_at_slot: u64,
    /// PDA bump.
    pub bump: u8,
}

impl IncidentCertificate {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 32 + 32 + 32 + 8 + 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1 + 8 + 8 + 1;

    /// True when `now_slot` is at or past expiry.
    pub fn is_expired(&self, now_slot: u64) -> bool {
        now_slot >= self.expires_at_slot
    }
}

/// The cohort's final receipt.
#[account]
pub struct SettlementReceipt {
    /// The operation this receipt belongs to.
    pub operation_id: [u8; 32],
    /// The certificate that authorised it.
    pub certificate: Pubkey,
    /// Whether the final action ran.
    pub finalized: bool,
    /// How many actions the cohort claimed to contain.
    pub observed_action_count: u16,
    /// Slot the receipt was finalized.
    pub finalized_at_slot: u64,
    /// PDA bump.
    pub bump: u8,
}

impl SettlementReceipt {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 32 + 32 + 1 + 2 + 8 + 1;
}

#[event]
pub struct SettlementFinalized {
    pub operation_id: [u8; 32],
    pub observed_action_count: u16,
}

#[error_code]
pub enum CoreError {
    #[msg("Operation ID must not be zero")]
    ZeroOperationId,
    #[msg("Action bundle hash must not be zero")]
    ZeroActionBundleHash,
    #[msg("Certificate expires at or before it was issued")]
    CertificateExpiresBeforeIssue,
    #[msg("A certificate must carry at least one approval")]
    CertificateWithoutApprovals,
    #[msg("Account does not belong to this operation")]
    OperationMismatch,
    #[msg("Settlement receipt does not reference this certificate")]
    CertificateMismatch,
    #[msg("This settlement was already finalized")]
    SettlementAlreadyFinalized,
    #[msg("Action count is outside the permitted cohort size")]
    InvalidActionCount,
    #[msg("A cohort has already been scheduled for this operation")]
    CohortAlreadyScheduled,
    #[msg("Remaining accounts do not match the declared adapter action count")]
    AdapterAccountCountMismatch,
    #[msg("Attempt count overflowed")]
    AttemptCountOverflow,
    #[msg("Operation account is not owned by this program")]
    OperationWrongOwner,
    #[msg("Operation account has the wrong discriminator")]
    OperationWrongDiscriminator,
    #[msg("Operation account is malformed")]
    OperationAccountMalformed,
    #[msg("A protected incident field still holds non-zero bytes")]
    PrivateFieldsNotZeroized,
    #[msg("The incident has not been marked zeroized")]
    ZeroizationFlagNotSet,
    #[msg("The incident is not accepting attestations")]
    IncidentNotCollecting,
    #[msg("The incident's response window has closed")]
    IncidentExpired,
    #[msg("A decision must be Approve, Reject, or Abstain")]
    DecisionRequired,
    #[msg("This key is not in the incident's frozen member set")]
    NotAnEligibleMember,
    #[msg("This member is quarantined for this incident")]
    MemberQuarantined,
    #[msg("Submission nonce must exceed the member's previous nonce")]
    NonceNotIncreasing,
    #[msg("Permission member list exceeds the incident bound")]
    TooManyPermissionMembers,
    #[msg("A permission needs at least one member")]
    PermissionNeedsAMember,
    #[msg("Approval threshold must be greater than zero")]
    ZeroThreshold,
    #[msg("Approval threshold exceeds the member set")]
    ThresholdExceedsMembers,
    #[msg("Response window must be greater than zero")]
    ZeroResponseWindow,
    #[msg("The incident has already been opened")]
    IncidentAlreadyOpened,
    #[msg("Only the opening responder may submit the private claim")]
    NotTheOpener,
    #[msg("Private payload exceeds its bound")]
    PrivatePayloadTooLong,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Quarantine changed the approval threshold")]
    QuarantineChangedThreshold,
    #[msg("The incident is neither certified nor expired")]
    IncidentNotTerminal,
    #[msg("Incident account is not owned by this program")]
    IncidentWrongOwner,
    #[msg("Incident account is malformed")]
    IncidentAccountMalformed,
    #[msg("The attestation accounts supplied do not match the incident's member count")]
    AttestationCountMismatch,
    #[msg("Member set must be strictly ascending with no repeats")]
    MemberSetNotAscending,
    #[msg("The ballots supplied are not the set frozen at open")]
    BallotSetDoesNotMatchSnapshot,
    #[msg("This ballot is in a state that cannot be counted")]
    BallotNotCountable,
    #[msg("Account schema version is not the one this program supports")]
    UnsupportedSchemaVersion,
    #[msg("The covenant is not a draft")]
    CovenantNotDraft,
    #[msg("The covenant has not been ratified")]
    CovenantNotRatified,
    #[msg("The covenant is not armed, so no incident may open under it")]
    CovenantNotArmed,
    #[msg("The covenant epoch is outside its validity window")]
    CovenantOutOfWindow,
    #[msg("Only the convening steward may do this")]
    NotTheSteward,
    #[msg("Only this membership's protocol authority may do this")]
    NotTheProtocolAuthority,
    #[msg("A member has not ratified its own membership")]
    MemberHasNotRatified,
    #[msg("This membership has already ratified")]
    AlreadyRatified,
    #[msg("This membership owns no adapter")]
    MemberOwnsNoAdapter,
    #[msg("Adapter version must be greater than zero")]
    ZeroAdapterVersion,
    #[msg("This membership has already armed")]
    AlreadyArmed,
    #[msg("An adapter-owning member has not armed")]
    AdapterNotArmed,
    #[msg("The incident has not certified, so it has no certificate to publish")]
    IncidentNotCertified,
    #[msg("Only the incident's opener may do this")]
    IncidentWrongOpener,
    #[msg("The account supplied as the magic program is not the magic program")]
    UnexpectedMagicProgram,
    #[msg("A crank interval of zero would schedule a task that never waits")]
    CrankIntervalZero,
    #[msg("Crank iterations must be between one and MAX_EXPIRY_ITERATIONS")]
    CrankIterationsOutOfRange,
    #[msg("The crank instruction could not be encoded")]
    CrankEncodingFailed,
}

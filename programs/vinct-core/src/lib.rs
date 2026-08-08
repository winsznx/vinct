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

declare_id!("9BaZmGntudyAL5VodBWFCANchn7vx1Y7DNpXADbx6JcG");

/// Seed for a certificate account.
pub const CERTIFICATE_SEED: &[u8] = b"certificate";
/// Seed for a settlement receipt.
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
/// Seed for the PDA that signs settlement receipts written by a Magic Action.
pub const SETTLEMENT_AUTHORITY_SEED: &[u8] = b"settlement-authority";
/// Seed for the delegated settlement operation account.
pub const OPERATION_SEED: &[u8] = b"operation";

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

    /// Publishes a certificate for one operation.
    ///
    /// In Phase 5 this becomes the terminal step of the private incident lifecycle, callable
    /// only by the incident's own scrub-and-certify path. Until then the issuing authority is
    /// an explicit signer recorded on the account, so an adapter can always tell which key
    /// stood behind a certificate it is being asked to honour.
    pub fn publish_certificate(
        ctx: Context<PublishCertificate>,
        args: PublishCertificateArgs,
    ) -> Result<()> {
        require!(args.operation_id != [0u8; 32], CoreError::ZeroOperationId);
        require!(
            args.action_bundle_hash != [0u8; 32],
            CoreError::ZeroActionBundleHash
        );
        require!(
            args.expires_at_slot > args.certified_at_slot,
            CoreError::CertificateExpiresBeforeIssue
        );
        require!(
            args.approval_count > 0,
            CoreError::CertificateWithoutApprovals
        );

        let certificate = &mut ctx.accounts.certificate;
        certificate.issuing_authority = ctx.accounts.issuing_authority.key();
        certificate.cluster_genesis_hash = args.cluster_genesis_hash;
        certificate.covenant = args.covenant;
        certificate.circle_epoch = args.circle_epoch;
        certificate.incident_id = args.incident_id;
        certificate.policy_id = args.policy_id;
        certificate.member_set_hash = args.member_set_hash;
        certificate.action_bundle_hash = args.action_bundle_hash;
        certificate.operation_id = args.operation_id;
        certificate.certificate_nonce = args.certificate_nonce;
        certificate.approval_count = args.approval_count;
        certificate.rejection_count = args.rejection_count;
        certificate.certified_at_slot = args.certified_at_slot;
        certificate.expires_at_slot = args.expires_at_slot;
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
    // Private incident lifecycle
    // ------------------------------------------------------------------------

    /// Base layer. Creates the public incident core.
    ///
    /// Nothing here is private, so nothing here is permissioned. It is the account an
    /// observer reads to learn that an incident is open and when it closes, and it is
    /// deliberately incapable of telling them anything else.
    pub fn initialize_incident(
        ctx: Context<InitializeIncident>,
        incident_id: u64,
        covenant: Pubkey,
    ) -> Result<()> {
        let core = &mut ctx.accounts.core;
        core.covenant = covenant;
        core.incident_id = incident_id;
        core.opener = ctx.accounts.opener.key();
        core.status = incident::IncidentStatus::Draft;
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
        fund_for_permission(
            &ctx.accounts.system_program,
            &ctx.accounts.opener,
            &ctx.accounts.attestation.to_account_info(),
            1,
        )?;
        let attestation = &mut ctx.accounts.attestation;
        attestation.incident = ctx.accounts.core.key();
        attestation.member = member;
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
    pub fn delegate_claim(ctx: Context<DelegateClaim>, core: Pubkey) -> Result<()> {
        require_opener_of_core(&ctx.accounts.core, ctx.accounts.opener.key())?;
        require_keys_eq!(core, ctx.accounts.core.key(), CoreError::OperationMismatch);
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
        require_opener_of_core(&ctx.accounts.core, ctx.accounts.opener.key())?;
        require_keys_eq!(core, ctx.accounts.core.key(), CoreError::OperationMismatch);
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
    pub fn open_incident(
        ctx: Context<OpenIncident>,
        args: incident::OpenIncidentArgs,
    ) -> Result<()> {
        require!(args.required_approvals > 0, CoreError::ZeroThreshold);
        require!(
            usize::from(args.member_count) <= incident::MAX_INCIDENT_MEMBERS,
            CoreError::TooManyPermissionMembers
        );
        require!(args.member_count > 0, CoreError::PermissionNeedsAMember);
        require!(
            args.required_approvals <= args.member_count,
            CoreError::ThresholdExceedsMembers
        );
        require!(
            args.response_window_slots > 0,
            CoreError::ZeroResponseWindow
        );

        let clock = Clock::get()?;
        let core = &mut ctx.accounts.core;
        require!(
            core.status == incident::IncidentStatus::Draft,
            CoreError::IncidentAlreadyOpened
        );

        core.circle_epoch = args.circle_epoch;
        core.policy_id = args.policy_id;
        core.member_set_hash = args.member_set_hash;
        core.cluster_genesis_hash = args.cluster_genesis_hash;
        core.required_approvals = args.required_approvals;
        core.maximum_rejections = args.maximum_rejections;
        core.opened_at_slot = clock.slot;
        core.expires_at_slot = clock
            .slot
            .checked_add(args.response_window_slots)
            .ok_or(CoreError::ArithmeticOverflow)?;
        core.claim_digest = args.claim_digest;
        core.member_count = args.member_count;
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
        ctx.accounts.attestation.quarantined = true;
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

        let attestations = read_supplied_attestations(
            ctx.accounts.core.key(),
            ctx.remaining_accounts,
            usize::from(ctx.accounts.core.member_count),
        )?;
        let tally = incident::tally(&attestations);
        let certified = tally.meets(&ctx.accounts.core);
        let expired = ctx.accounts.core.is_expired(clock.slot);
        require!(certified || expired, CoreError::IncidentNotTerminal);

        let core = &mut ctx.accounts.core;
        core.approval_count_after_terminal = tally.approvals;
        core.rejection_count_after_terminal = tally.rejections;
        core.status = if certified {
            incident::IncidentStatus::CertifiedPendingSettlement
        } else {
            incident::IncidentStatus::Expired
        };

        emit!(IncidentCertified {
            incident_id: core.incident_id,
            status: core.status,
            approval_count: core.approval_count_after_terminal,
            rejection_count: core.rejection_count_after_terminal,
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
    incident::IncidentCore::try_deserialize(&mut &data[..])
        .map_err(|_| error!(CoreError::IncidentAccountMalformed))
}

/// Reads every attestation supplied in `remaining_accounts`, checked against the incident.
///
/// Owner before bytes, then the incident it claims to belong to, then its own PDA derivation
/// from that incident and the member it names. A duplicate would let one approval be counted
/// twice, so the list is checked for repeats as it is read.
fn read_supplied_attestations(
    core_key: Pubkey,
    supplied: &[AccountInfo],
    expected: usize,
) -> Result<Vec<incident::MemberAttestation>> {
    require!(
        supplied.len() == expected,
        CoreError::AttestationCountMismatch
    );
    let mut attestations = Vec::with_capacity(expected);
    for (index, info) in supplied.iter().enumerate() {
        require_keys_eq!(*info.owner, crate::ID, CoreError::IncidentWrongOwner);
        let attestation =
            incident::MemberAttestation::try_deserialize(&mut &info.try_borrow_data()?[..])
                .map_err(|_| error!(CoreError::IncidentAccountMalformed))?;
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

        for earlier in supplied.iter().take(index) {
            require_keys_neq!(info.key(), earlier.key(), CoreError::DuplicateAttestation);
        }
        attestations.push(attestation);
    }
    Ok(attestations)
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

    let attestations = read_supplied_attestations(
        core_key,
        ctx.remaining_accounts,
        usize::from(core.member_count),
    )?;
    for attestation in &attestations {
        attestation.may_leave_the_private_runtime()?;
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
    /// CHECK: read by hand to check the opener; not mutated here.
    pub core: UncheckedAccount<'info>,
    /// CHECK: delegated by the delegation program.
    #[account(mut, del, seeds = [incident::CLAIM_SEED, core.key().as_ref()], bump)]
    pub claim: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(core: Pubkey, member: Pubkey)]
pub struct DelegateAttestation<'info> {
    pub opener: Signer<'info>,
    /// CHECK: read by hand to check the opener; not mutated here.
    pub core: UncheckedAccount<'info>,
    /// CHECK: delegated by the delegation program.
    #[account(
        mut,
        del,
        seeds = [incident::ATTESTATION_SEED, core.key().as_ref(), member.as_ref()],
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

#[derive(Accounts)]
pub struct OpenIncident<'info> {
    #[account(mut, has_one = opener @ CoreError::NotTheOpener)]
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
    #[account(mut)]
    pub core: Account<'info, incident::IncidentCore>,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PublishCertificateArgs {
    pub cluster_genesis_hash: [u8; 32],
    pub covenant: Pubkey,
    pub circle_epoch: u64,
    pub incident_id: u64,
    pub policy_id: [u8; 32],
    pub member_set_hash: [u8; 32],
    pub action_bundle_hash: [u8; 32],
    pub operation_id: [u8; 32],
    pub certificate_nonce: u64,
    pub approval_count: u8,
    pub rejection_count: u8,
    pub certified_at_slot: u64,
    pub expires_at_slot: u64,
}

#[derive(Accounts)]
#[instruction(args: PublishCertificateArgs)]
pub struct PublishCertificate<'info> {
    #[account(
        init,
        payer = issuing_authority,
        space = 8 + IncidentCertificate::SIZE,
        seeds = [CERTIFICATE_SEED, args.operation_id.as_ref()],
        bump
    )]
    pub certificate: Account<'info, IncidentCertificate>,
    #[account(mut)]
    pub issuing_authority: Signer<'info>,
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
    #[msg("The same attestation account was supplied twice")]
    DuplicateAttestation,
}

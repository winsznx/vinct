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

use anchor_lang::prelude::*;

declare_id!("9BaZmGntudyAL5VodBWFCANchn7vx1Y7DNpXADbx6JcG");

/// Seed for a certificate account.
pub const CERTIFICATE_SEED: &[u8] = b"certificate";
/// Seed for a settlement receipt.
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
/// Seed for the PDA that signs settlement receipts written by a Magic Action.
pub const SETTLEMENT_AUTHORITY_SEED: &[u8] = b"settlement-authority";

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
}

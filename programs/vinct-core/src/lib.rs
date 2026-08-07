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
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
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
        let operation = &ctx.accounts.operation;
        require!(!operation.scheduled, CoreError::CohortAlreadyScheduled);
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

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.operation.to_account_info()])
        .add_post_commit_actions(actions)
        .build_and_invoke()?;

        let operation = &mut ctx.accounts.operation;
        operation.scheduled = true;
        operation.scheduled_at_slot = Clock::get()?.slot;
        operation.attempt_count = operation
            .attempt_count
            .checked_add(1)
            .ok_or(CoreError::AttemptCountOverflow)?;

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
    /// How many adapter actions precede the settlement action.
    pub adapter_action_count: u16,
    /// Per-action compute budget for each adapter action.
    pub adapter_compute_units: u32,
    /// Compute budget for the final settlement action.
    pub settlement_compute_units: u32,
}

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
pub struct ScheduleSettlementCohort<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [OPERATION_SEED, operation.operation_id.as_ref()],
        bump = operation.bump
    )]
    pub operation: Account<'info, SettlementOperation>,
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
}

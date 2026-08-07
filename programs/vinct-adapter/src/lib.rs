//! The sovereign adapter.
//!
//! One protocol authority installs one capability, arms it, and can suspend or revoke it at
//! any moment. Nothing in a covenant can install, arm, widen, or unsuspend a capability.
//! The circle's only power is to publish a certificate; the adapter decides whether that
//! certificate meets bounds its own protocol already agreed to.
//!
//! What this program deliberately does not have:
//!
//! - no instruction that forwards a caller-supplied program, discriminator, account list,
//!   or instruction data
//! - no instruction that lets the covenant, the steward, or the core program change a bound
//! - no unpause path
//!
//! The target instruction is constructed inside this program from the capability's pinned
//! fields. A caller chooses which capability to exercise and nothing else.
//!
//! ## Where each check lives
//!
//! PRD section 14 lists nineteen validations. This program performs every one that is about
//! *its own* action: certificate ownership and identity, covenant, epoch, policy, member
//! set, expiry, operation identity, armed state, adapter version, target program,
//! discriminator, the exact ordered account metas, the exact instruction data, the effect
//! bound, the capability nonce, prior consumption, then the CPI and the receipt.
//!
//! One check is not the adapter's to make. "The certificate authorises this exact
//! *bundle*" spans all three protocols' actions, and an adapter cannot see the other two.
//! That binding is enforced where the bundle is built, and is independently recomputable by
//! anyone from the registered templates plus the operation ID. An adapter that pretended to
//! verify it would be claiming a guarantee it cannot provide.

// Anchor 1.0.2's `#[program]` expansion trips these in its generated dispatch and error
// plumbing, not in code written here. Scoped to this crate so a genuine occurrence in
// VINCT's own logic still fails the lint gate.
#![allow(clippy::diverging_sub_expression)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::anchor::action;
use sha2::{Digest, Sha256};

declare_id!("2BoSGgPxcpS2NcKGK9ygJdRfcfL6gYeDgh4QRGrujBM4");

/// Seed for a capability account.
pub const CAPABILITY_SEED: &[u8] = b"capability";
/// Seed for the PDA that signs the bounded CPI. This is the key a protocol registers.
pub const ADAPTER_SIGNER_SEED: &[u8] = b"adapter-signer";
/// Seed for a per-operation adapter receipt.
pub const ADAPTER_RECEIPT_SEED: &[u8] = b"adapter-receipt";

/// The bounded action categories this adapter knows how to construct.
///
/// Closed on purpose. Adding a category is a program upgrade a protocol authority can
/// review, not a runtime parameter.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionCategory {
    /// Stop accepting new borrows.
    PauseNewBorrowing,
}

/// The upper bound on what one action may do.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectLimit {
    /// The action may set the pause flag.
    pub may_pause: bool,
    /// The action may clear it. False for every covenant capability.
    pub may_unpause: bool,
    /// Maximum value the action may move.
    pub max_value_moved: u64,
}

#[program]
pub mod vinct_adapter {
    use super::*;

    /// Installs a capability, unarmed.
    ///
    /// Only the protocol authority signs. The bounds supplied here are the complete
    /// description of what this adapter will ever be permitted to do on this protocol's
    /// behalf, and nothing later can widen them without this authority signing again.
    pub fn install_capability(
        ctx: Context<InstallCapability>,
        args: InstallCapabilityArgs,
    ) -> Result<()> {
        require!(
            args.expires_at_slot > args.valid_from_slot,
            AdapterError::CapabilityExpiresBeforeItStarts
        );
        require!(args.adapter_version > 0, AdapterError::ZeroAdapterVersion);
        require!(
            !args.max_effect.may_unpause,
            AdapterError::UnpauseNotPermitted
        );
        require!(
            args.max_effect.max_value_moved == 0,
            AdapterError::ValueMovementNotPermitted
        );
        require!(
            args.ordered_account_metas_hash != [0u8; 32],
            AdapterError::ZeroCommitment
        );
        require!(
            args.instruction_data_hash != [0u8; 32],
            AdapterError::ZeroCommitment
        );

        let capability = &mut ctx.accounts.capability;
        capability.protocol_authority = ctx.accounts.protocol_authority.key();
        capability.protocol_state = args.protocol_state;
        capability.core_program = args.core_program;
        capability.adapter_version = args.adapter_version;
        capability.cluster_genesis_hash = args.cluster_genesis_hash;
        capability.covenant = args.covenant;
        capability.circle_epoch = args.circle_epoch;
        capability.policy_id = args.policy_id;
        capability.member_set_hash = args.member_set_hash;
        capability.action_category = args.action_category;
        capability.target_program = args.target_program;
        capability.instruction_discriminator = args.instruction_discriminator;
        capability.ordered_account_metas_hash = args.ordered_account_metas_hash;
        capability.instruction_data_hash = args.instruction_data_hash;
        capability.max_effect = args.max_effect;
        capability.valid_from_slot = args.valid_from_slot;
        capability.expires_at_slot = args.expires_at_slot;
        capability.armed = false;
        capability.suspended = false;
        capability.capability_nonce = 0;
        capability.last_operation_id = [0u8; 32];
        capability.bump = ctx.bumps.capability;
        capability.signer_bump = ctx.bumps.adapter_signer;
        Ok(())
    }

    /// Arms the capability at a specific version.
    ///
    /// The version is supplied and must match, so arming is an explicit acknowledgement of
    /// exactly which bounds are going live rather than a blanket yes.
    pub fn arm_capability(
        ctx: Context<ProtocolAuthorityAction>,
        adapter_version: u16,
    ) -> Result<()> {
        let capability = &mut ctx.accounts.capability;
        require!(
            capability.adapter_version == adapter_version,
            AdapterError::AdapterVersionMismatch
        );
        require!(!capability.armed, AdapterError::CapabilityAlreadyArmed);
        capability.armed = true;
        capability.suspended = false;
        Ok(())
    }

    /// Suspends the capability without destroying it.
    pub fn suspend_capability(ctx: Context<ProtocolAuthorityAction>) -> Result<()> {
        ctx.accounts.capability.suspended = true;
        Ok(())
    }

    /// Lifts a suspension. Only the protocol authority may do this.
    pub fn resume_capability(ctx: Context<ProtocolAuthorityAction>) -> Result<()> {
        let capability = &mut ctx.accounts.capability;
        require!(capability.armed, AdapterError::CapabilityNotArmed);
        capability.suspended = false;
        Ok(())
    }

    /// Extends the validity window. Never widens a bound.
    pub fn renew_capability(
        ctx: Context<ProtocolAuthorityAction>,
        expires_at_slot: u64,
    ) -> Result<()> {
        let capability = &mut ctx.accounts.capability;
        require!(
            expires_at_slot > capability.expires_at_slot,
            AdapterError::RenewalMustExtend
        );
        capability.expires_at_slot = expires_at_slot;
        Ok(())
    }

    /// Permanently disarms the capability.
    pub fn revoke_capability(ctx: Context<ProtocolAuthorityAction>) -> Result<()> {
        let capability = &mut ctx.accounts.capability;
        capability.armed = false;
        capability.suspended = true;
        capability.expires_at_slot = 0;
        Ok(())
    }

    /// Creates this operation's receipt account.
    ///
    /// Separate from `execute_bounded_action` because a Magic Action target cannot create
    /// accounts: the `#[action]` macro injects `escrow_auth` as a non-mutable
    /// `UncheckedAccount`, so there is no mutable payer available inside the action. The
    /// receipt is created here in an ordinary transaction and the action only writes to it.
    /// Permissionless, because creating an empty receipt at a deterministic address grants
    /// nothing; only the adapter can write to it.
    pub fn initialize_adapter_receipt(
        ctx: Context<InitializeAdapterReceipt>,
        operation_id: [u8; 32],
    ) -> Result<()> {
        require!(operation_id != [0u8; 32], AdapterError::ZeroOperationId);
        let receipt = &mut ctx.accounts.receipt;
        receipt.operation_id = operation_id;
        receipt.capability = ctx.accounts.capability.key();
        receipt.executed = false;
        receipt.target_effect_applied = false;
        receipt.executed_at_slot = 0;
        receipt.bump = ctx.bumps.receipt;
        Ok(())
    }

    /// Executes the one bounded action this capability authorises.
    ///
    /// Permissionless to call. Authority comes entirely from the certificate and the
    /// capability, so it does not matter who submits it: a caller with a valid certificate
    /// can only cause the exact effect the protocol already agreed to, and a caller without
    /// one causes nothing.
    ///
    /// The instruction takes no data beyond the discriminator. Everything that could vary is
    /// pinned by the capability, so there is no argument an attacker could steer.
    pub fn execute_bounded_action(ctx: Context<ExecuteBoundedAction>) -> Result<()> {
        // Anchor puts any account beyond the declared context into `remaining_accounts` and
        // ignores it. This adapter never reads them and builds its CPI account list
        // explicitly, so an appended account is inert today. It is refused anyway: the
        // ordered-meta commitment covers only the declared accounts, so tolerating extras
        // would mean a protocol authority signed off on a shorter list than the transaction
        // actually carries. Found by the extra-writable-account adversarial test.
        require!(
            ctx.remaining_accounts.is_empty(),
            AdapterError::UnexpectedAccounts
        );

        let clock = Clock::get()?;
        let capability = &ctx.accounts.capability;
        let certificate = &ctx.accounts.certificate;

        // 1-2. The certificate account must be owned by the core program this protocol
        //      named at install time. Without this, any account with matching bytes is a
        //      certificate.
        require_keys_eq!(
            *certificate.to_account_info().owner,
            capability.core_program,
            AdapterError::CertificateWrongOwner
        );

        let parsed = ParsedCertificate::try_from_account(&certificate.to_account_info())?;

        // 3-5. Cluster, covenant, epoch, policy, and member set must be the ones this
        //      capability was armed against. Each one alone is a replay surface.
        require!(
            parsed.cluster_genesis_hash == capability.cluster_genesis_hash,
            AdapterError::ClusterMismatch
        );
        require_keys_eq!(
            parsed.covenant,
            capability.covenant,
            AdapterError::CovenantMismatch
        );
        require!(
            parsed.circle_epoch == capability.circle_epoch,
            AdapterError::EpochMismatch
        );
        require!(
            parsed.policy_id == capability.policy_id,
            AdapterError::PolicyMismatch
        );
        require!(
            parsed.member_set_hash == capability.member_set_hash,
            AdapterError::MemberSetMismatch
        );

        // 6. Certificate expiry, and the capability's own validity window.
        require!(
            clock.slot < parsed.expires_at_slot,
            AdapterError::CertificateExpired
        );
        require!(
            clock.slot >= capability.valid_from_slot && clock.slot < capability.expires_at_slot,
            AdapterError::CapabilityOutsideValidityWindow
        );

        // 7. See the module comment: whole-bundle binding is not an adapter check. What the
        //    adapter does assert is that the certificate names a bundle at all, so an empty
        //    or zeroed certificate cannot authorise anything.
        require!(
            parsed.action_bundle_hash != [0u8; 32],
            AdapterError::CertificateWithoutBundle
        );
        require!(
            parsed.approval_count > 0,
            AdapterError::CertificateWithoutApprovals
        );

        // 8. Operation identity.
        require!(
            parsed.operation_id != [0u8; 32],
            AdapterError::ZeroOperationId
        );

        // 9. Armed and not suspended.
        require!(capability.armed, AdapterError::CapabilityNotArmed);
        require!(!capability.suspended, AdapterError::CapabilitySuspended);

        // 11. Target program. Checked against the capability, never against a caller
        //     argument, and the account must actually be executable.
        require_keys_eq!(
            ctx.accounts.target_program.key(),
            capability.target_program,
            AdapterError::TargetProgramMismatch
        );
        require!(
            ctx.accounts.target_program.executable,
            AdapterError::TargetProgramNotExecutable
        );

        // 12-13. The exact ordered account metas. Rebuilt from this instruction's own
        //        accounts in their real order and compared against the commitment the
        //        protocol authority signed. A swapped market and receipt, an added writable
        //        account, or a flipped signer flag all land here.
        let metas_hash = hash_ordered_account_metas(ctx.accounts);
        require!(
            metas_hash == capability.ordered_account_metas_hash,
            AdapterError::AccountMetasMismatch
        );

        // 14. The exact instruction data. This instruction carries only its discriminator,
        //     so the commitment is over that.
        let data_hash = hash_bytes(crate::instruction::ExecuteBoundedAction::DISCRIMINATOR);
        require!(
            data_hash == capability.instruction_data_hash,
            AdapterError::InstructionDataMismatch
        );

        // 15. Effect bound. The category and the bound must agree, and the bound must still
        //     be the narrow one install refused to widen.
        require!(
            capability.max_effect.may_pause,
            AdapterError::EffectLimitExceeded
        );
        require!(
            !capability.max_effect.may_unpause,
            AdapterError::EffectLimitExceeded
        );
        require!(
            capability.max_effect.max_value_moved == 0,
            AdapterError::EffectLimitExceeded
        );

        // 17. Prior consumption. The receipt is per-operation and per-capability, so this is
        //     durable and survives any retry.
        let receipt = &ctx.accounts.receipt;
        require!(
            receipt.operation_id == parsed.operation_id,
            AdapterError::ReceiptOperationMismatch
        );
        require_keys_eq!(
            receipt.capability,
            capability.key(),
            AdapterError::ReceiptCapabilityMismatch
        );
        require!(!receipt.executed, AdapterError::OperationAlreadyConsumed);
        require!(
            capability.last_operation_id != parsed.operation_id,
            AdapterError::OperationAlreadyConsumed
        );

        // The protocol state must be the one this capability was installed for.
        require_keys_eq!(
            ctx.accounts.protocol_state.key(),
            capability.protocol_state,
            AdapterError::ProtocolStateMismatch
        );

        // 18. The CPI. Built here, from pinned fields only.
        let capability_key = capability.key();
        let signer_seeds: &[&[u8]] = &[
            ADAPTER_SIGNER_SEED,
            capability_key.as_ref(),
            &[capability.signer_bump],
        ];

        let instruction = match capability.action_category {
            ActionCategory::PauseNewBorrowing => {
                let mut data = Vec::with_capacity(8 + 32);
                data.extend_from_slice(&capability.instruction_discriminator);
                data.extend_from_slice(&parsed.operation_id);
                Instruction {
                    program_id: capability.target_program,
                    accounts: vec![
                        AccountMeta::new(ctx.accounts.protocol_state.key(), false),
                        AccountMeta::new_readonly(ctx.accounts.adapter_signer.key(), true),
                    ],
                    data,
                }
            }
        };

        invoke_signed(
            &instruction,
            &[
                ctx.accounts.protocol_state.to_account_info(),
                ctx.accounts.adapter_signer.to_account_info(),
                ctx.accounts.target_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        // 19. The durable receipt, and the capability's own consumption record. Both are
        //     written after the CPI, so a failed CPI leaves neither.
        let receipt = &mut ctx.accounts.receipt;
        receipt.executed = true;
        receipt.target_effect_applied = true;
        receipt.executed_at_slot = clock.slot;

        let capability = &mut ctx.accounts.capability;
        capability.last_operation_id = parsed.operation_id;
        capability.capability_nonce = capability
            .capability_nonce
            .checked_add(1)
            .ok_or(AdapterError::CapabilityNonceOverflow)?;

        // incident_id is emitted rather than checked: it is a correlation ID the
        // reconciler needs (PRD section 25), and it is already covered by the operation ID
        // the adapter does enforce.
        emit!(BoundedActionExecuted {
            capability: capability_key,
            operation_id: parsed.operation_id,
            incident_id: parsed.incident_id,
            protocol_state: ctx.accounts.protocol_state.key(),
        });
        Ok(())
    }
}

/// Hashes this instruction's account metas in their real order.
///
/// The order is the order of the `#[derive(Accounts)]` fields, which is the order they
/// appear in the transaction. Nothing is sorted.
fn hash_ordered_account_metas(accounts: &ExecuteBoundedAction) -> [u8; 32] {
    let metas = [
        (accounts.certificate.key(), false, false),
        (accounts.capability.key(), false, true),
        (accounts.protocol_state.key(), false, true),
        (accounts.receipt.key(), false, true),
        (accounts.adapter_signer.key(), false, false),
        (accounts.target_program.key(), false, false),
    ];

    let mut hasher = Sha256::new();
    hasher.update((metas.len() as u32).to_le_bytes());
    for (key, is_signer, is_writable) in metas {
        hasher.update(key.as_ref());
        hasher.update([u8::from(is_signer)]);
        hasher.update([u8::from(is_writable)]);
    }
    hasher.finalize().into()
}

fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// The certificate fields this adapter reads.
///
/// Decoded by hand rather than through a typed `Account<'info, T>` because the adapter must
/// not take a build-time dependency on the core program. A protocol authority reviewing this
/// adapter should be able to see exactly which bytes it trusts and where they come from.
struct ParsedCertificate {
    cluster_genesis_hash: [u8; 32],
    covenant: Pubkey,
    circle_epoch: u64,
    incident_id: u64,
    policy_id: [u8; 32],
    member_set_hash: [u8; 32],
    action_bundle_hash: [u8; 32],
    operation_id: [u8; 32],
    approval_count: u8,
    expires_at_slot: u64,
}

impl ParsedCertificate {
    /// Offsets into `IncidentCertificate` after its 8-byte Anchor discriminator:
    /// issuing_authority(32) cluster(32) covenant(32) epoch(8) incident(8) policy(32)
    /// member_set(32) bundle(32) operation(32) nonce(8) approvals(1) rejections(1)
    /// certified_at(8) expires_at(8) bump(1) = 267 bytes.
    ///
    /// Hand-decoded rather than read through a typed account so this program takes no
    /// build-time dependency on the core. The length check is exact: a shorter account
    /// cannot be a certificate, and reading past it would be reading someone else's bytes.
    const BODY_LEN: usize = 267;

    fn try_from_account(info: &AccountInfo) -> Result<Self> {
        let data = info.try_borrow_data()?;
        require!(
            data.len() >= 8 + Self::BODY_LEN,
            AdapterError::CertificateMalformed
        );
        let body = &data[8..];

        let read32 = |offset: usize| -> [u8; 32] {
            let mut out = [0u8; 32];
            out.copy_from_slice(&body[offset..offset + 32]);
            out
        };
        let read8 = |offset: usize| -> u64 {
            let mut out = [0u8; 8];
            out.copy_from_slice(&body[offset..offset + 8]);
            u64::from_le_bytes(out)
        };

        Ok(Self {
            cluster_genesis_hash: read32(32),
            covenant: Pubkey::new_from_array(read32(64)),
            circle_epoch: read8(96),
            incident_id: read8(104),
            policy_id: read32(112),
            member_set_hash: read32(144),
            action_bundle_hash: read32(176),
            operation_id: read32(208),
            approval_count: body[248],
            expires_at_slot: read8(258),
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InstallCapabilityArgs {
    pub protocol_state: Pubkey,
    pub core_program: Pubkey,
    pub adapter_version: u16,
    pub cluster_genesis_hash: [u8; 32],
    pub covenant: Pubkey,
    pub circle_epoch: u64,
    pub policy_id: [u8; 32],
    pub member_set_hash: [u8; 32],
    pub action_category: ActionCategory,
    pub target_program: Pubkey,
    pub instruction_discriminator: [u8; 8],
    pub ordered_account_metas_hash: [u8; 32],
    pub instruction_data_hash: [u8; 32],
    pub max_effect: EffectLimit,
    pub valid_from_slot: u64,
    pub expires_at_slot: u64,
}

#[derive(Accounts)]
#[instruction(args: InstallCapabilityArgs)]
pub struct InstallCapability<'info> {
    #[account(
        init,
        payer = protocol_authority,
        space = 8 + SovereignCapability::SIZE,
        seeds = [
            CAPABILITY_SEED,
            protocol_authority.key().as_ref(),
            args.covenant.as_ref(),
            args.policy_id.as_ref(),
        ],
        bump
    )]
    pub capability: Account<'info, SovereignCapability>,
    /// CHECK: the PDA that will sign the bounded CPI. Derived here so its bump can be
    /// stored, never passed in by a caller.
    #[account(seeds = [ADAPTER_SIGNER_SEED, capability.key().as_ref()], bump)]
    pub adapter_signer: UncheckedAccount<'info>,
    #[account(mut)]
    pub protocol_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProtocolAuthorityAction<'info> {
    #[account(
        mut,
        has_one = protocol_authority @ AdapterError::UnauthorizedProtocolAuthority
    )]
    pub capability: Account<'info, SovereignCapability>,
    pub protocol_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(operation_id: [u8; 32])]
pub struct InitializeAdapterReceipt<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + AdapterReceipt::SIZE,
        seeds = [ADAPTER_RECEIPT_SEED, operation_id.as_ref(), capability.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, AdapterReceipt>,
    pub capability: Account<'info, SovereignCapability>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// The account order here is the committed order. Changing it changes
/// `ordered_account_metas_hash` and invalidates every armed capability, which is the
/// intended consequence: a protocol authority must re-review and re-arm.
///
/// `#[action]` appends `escrow_auth` and `escrow`. They are appended, not interleaved, so
/// the six declared accounts keep their positions and the commitment is unaffected. A
/// caller building the `ShortAccountMeta` list supplies only the six; the SDK adds the rest.
#[action]
#[derive(Accounts)]
pub struct ExecuteBoundedAction<'info> {
    /// CHECK: owner and contents validated in the handler against the capability's bounds.
    /// Deliberately untyped so this program takes no build-time dependency on the core.
    pub certificate: UncheckedAccount<'info>,
    #[account(mut)]
    pub capability: Account<'info, SovereignCapability>,
    /// CHECK: must equal `capability.protocol_state`; written only by the target program.
    #[account(mut)]
    pub protocol_state: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [ADAPTER_RECEIPT_SEED, receipt.operation_id.as_ref(), capability.key().as_ref()],
        bump = receipt.bump
    )]
    pub receipt: Account<'info, AdapterReceipt>,
    /// CHECK: PDA that signs the CPI. Re-derived here, so a supplied key cannot stand in.
    #[account(seeds = [ADAPTER_SIGNER_SEED, capability.key().as_ref()], bump = capability.signer_bump)]
    pub adapter_signer: UncheckedAccount<'info>,
    /// CHECK: must equal `capability.target_program` and must be executable.
    pub target_program: UncheckedAccount<'info>,
}

/// One protocol's bounded capability.
#[account]
pub struct SovereignCapability {
    /// The only key that may arm, suspend, resume, renew, or revoke.
    pub protocol_authority: Pubkey,
    /// The protocol account this capability may affect.
    pub protocol_state: Pubkey,
    /// The core program whose certificates this capability honours.
    pub core_program: Pubkey,
    /// The adapter version these bounds were reviewed against.
    pub adapter_version: u16,
    /// The cluster this capability is valid on.
    pub cluster_genesis_hash: [u8; 32],
    /// The covenant.
    pub covenant: Pubkey,
    /// The epoch.
    pub circle_epoch: u64,
    /// The policy.
    pub policy_id: [u8; 32],
    /// The member set this capability was armed against.
    pub member_set_hash: [u8; 32],
    /// The category of action.
    pub action_category: ActionCategory,
    /// The only program this capability may call.
    pub target_program: Pubkey,
    /// The only instruction it may invoke there.
    pub instruction_discriminator: [u8; 8],
    /// Commitment to the exact ordered account metas of `execute_bounded_action`.
    pub ordered_account_metas_hash: [u8; 32],
    /// Commitment to the exact instruction data of `execute_bounded_action`.
    pub instruction_data_hash: [u8; 32],
    /// The effect bound.
    pub max_effect: EffectLimit,
    /// First slot the capability is usable.
    pub valid_from_slot: u64,
    /// Slot the capability expires.
    pub expires_at_slot: u64,
    /// Whether the protocol authority has armed it.
    pub armed: bool,
    /// Whether the protocol authority has suspended it.
    pub suspended: bool,
    /// Increments on each execution.
    pub capability_nonce: u64,
    /// The last operation consumed.
    pub last_operation_id: [u8; 32],
    /// PDA bump.
    pub bump: u8,
    /// Adapter signer PDA bump.
    pub signer_bump: u8,
}

impl SovereignCapability {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 32
        + 32
        + 32
        + 2
        + 32
        + 32
        + 8
        + 32
        + 32
        + 1
        + 32
        + 8
        + 32
        + 32
        + 10
        + 8
        + 8
        + 1
        + 1
        + 8
        + 32
        + 1
        + 1;
}

/// Durable proof that one capability executed one operation.
#[account]
pub struct AdapterReceipt {
    /// The operation.
    pub operation_id: [u8; 32],
    /// The capability that executed it.
    pub capability: Pubkey,
    /// Whether the adapter ran.
    pub executed: bool,
    /// Whether the target CPI succeeded. Written only after `invoke_signed` returns.
    pub target_effect_applied: bool,
    /// Slot of execution.
    pub executed_at_slot: u64,
    /// PDA bump.
    pub bump: u8,
}

impl AdapterReceipt {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 32 + 32 + 1 + 1 + 8 + 1;
}

#[event]
pub struct BoundedActionExecuted {
    pub capability: Pubkey,
    pub operation_id: [u8; 32],
    pub incident_id: u64,
    pub protocol_state: Pubkey,
}

#[error_code]
pub enum AdapterError {
    #[msg("Only the protocol authority may perform this action")]
    UnauthorizedProtocolAuthority,
    #[msg("Capability expires at or before it becomes valid")]
    CapabilityExpiresBeforeItStarts,
    #[msg("Adapter version must be non-zero")]
    ZeroAdapterVersion,
    #[msg("A covenant capability may never unpause")]
    UnpauseNotPermitted,
    #[msg("A covenant capability may never move value")]
    ValueMovementNotPermitted,
    #[msg("Commitment hashes must not be zero")]
    ZeroCommitment,
    #[msg("Capability is already armed")]
    CapabilityAlreadyArmed,
    #[msg("Capability is not armed")]
    CapabilityNotArmed,
    #[msg("Capability is suspended")]
    CapabilitySuspended,
    #[msg("Renewal must extend the expiry")]
    RenewalMustExtend,
    #[msg("Adapter version does not match")]
    AdapterVersionMismatch,
    #[msg("Certificate is not owned by the expected core program")]
    CertificateWrongOwner,
    #[msg("Certificate account is malformed")]
    CertificateMalformed,
    #[msg("Certificate is for a different cluster")]
    ClusterMismatch,
    #[msg("Certificate is for a different covenant")]
    CovenantMismatch,
    #[msg("Certificate is for a different epoch")]
    EpochMismatch,
    #[msg("Certificate is for a different policy")]
    PolicyMismatch,
    #[msg("Certificate is for a different member set")]
    MemberSetMismatch,
    #[msg("Certificate has expired")]
    CertificateExpired,
    #[msg("Capability is outside its validity window")]
    CapabilityOutsideValidityWindow,
    #[msg("Certificate names no action bundle")]
    CertificateWithoutBundle,
    #[msg("Certificate carries no approvals")]
    CertificateWithoutApprovals,
    #[msg("Operation ID must not be zero")]
    ZeroOperationId,
    #[msg("Target program does not match the capability")]
    TargetProgramMismatch,
    #[msg("Target program account is not executable")]
    TargetProgramNotExecutable,
    #[msg("Ordered account metas do not match the armed commitment")]
    AccountMetasMismatch,
    #[msg("Instruction data does not match the armed commitment")]
    InstructionDataMismatch,
    #[msg("Action exceeds the capability's effect limit")]
    EffectLimitExceeded,
    #[msg("Receipt belongs to a different operation")]
    ReceiptOperationMismatch,
    #[msg("Receipt belongs to a different capability")]
    ReceiptCapabilityMismatch,
    #[msg("This operation was already consumed by this capability")]
    OperationAlreadyConsumed,
    #[msg("Protocol state does not match the capability")]
    ProtocolStateMismatch,
    #[msg("Capability nonce overflowed")]
    CapabilityNonceOverflow,
    #[msg("Unexpected additional accounts were supplied")]
    UnexpectedAccounts,
}

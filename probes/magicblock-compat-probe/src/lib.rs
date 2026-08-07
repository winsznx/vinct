//! Phase 0 compatibility probe.
//!
//! This crate exists to prove that one dependency combination compiles against every
//! MagicBlock surface VINCT depends on. It contains no VINCT product logic, no covenant
//! model, no incident model, and no privacy guarantees. Delete or replace it once the
//! real programs exist.
//!
//! Surfaces exercised here:
//!   1. `#[ephemeral]` program module and the injected undelegation callback
//!   2. `#[delegate]` context and the generated `delegate_<field>` helper
//!   3. `#[commit]` context and `MagicIntentBundleBuilder` commit / commit-and-undelegate
//!   4. `MagicIntentBundleBuilder::magic_fee_vault` (commit sponsorship path)
//!   5. Magic Actions: `#[action]` target context, `CallHandler`, `ActionArgs`,
//!      `ShortAccountMeta`, `add_post_commit_actions`, and PDA-signed dispatch
//!   6. PER access control: create / update / close `EphemeralPermission` on the ER
//!   7. Crank: SDK `ScheduleCrankCpi` / `CancelCrankCpi` plus the raw
//!      `MagicBlockInstruction::ScheduleTask` bincode path used by the current example

// Anchor 1.0.2's `#[program]` expansion trips this lint in its generated dispatch
// code. Every occurrence points at the attribute itself, none at code written here.
// The allow is crate-scoped rather than repository-wide so a real diverging
// sub-expression in VINCT's own programs still fails the lint gate.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::system_program::{transfer, Transfer};

use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
    TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::crank::{CancelCrankCpi, ScheduleCrankCpi};
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

// Throwaway probe ID. Phase 0 never deploys this program, so no keypair is stored in
// the repository. Real program IDs are generated with `anchor keys sync` in Phase 2.
declare_id!("8WGMvBi8nigXpfzR62Jsz62WQzPifKUKhoFYdPk4i5i5");

pub const PROBE_SEED: &[u8] = b"compat-probe";
pub const RECEIPT_SEED: &[u8] = b"compat-probe-receipt";
pub const MAX_PERMISSION_MEMBERS: usize = 4;

#[ephemeral]
#[program]
pub mod magicblock_compat_probe {
    use super::*;

    /// Base layer. Creates the probe account and pre-funds it for the ER-local
    /// `EphemeralPermission` it will own after delegation.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.probe.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(
                MAX_PERMISSION_MEMBERS,
            ) as u32),
        )?;

        let probe = &mut ctx.accounts.probe;
        probe.authority = ctx.accounts.authority.key();
        probe.tick = 0;
        Ok(())
    }

    /// Base layer. Creates the Magic Action target account before any action is scheduled.
    pub fn initialize_receipt(ctx: Context<InitializeReceipt>) -> Result<()> {
        let receipt = &mut ctx.accounts.receipt;
        receipt.operation_id = [0u8; 32];
        receipt.observed = false;
        Ok(())
    }

    /// Base layer. Delegates the probe account to the (optionally pinned) validator.
    pub fn delegate(ctx: Context<DelegateProbe>) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref();
        ctx.accounts.delegate_probe(
            &ctx.accounts.authority,
            &[PROBE_SEED, ctx.accounts.authority.key().as_ref()],
            DelegateConfig {
                validator: validator.map(|v| v.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// ER. Ordinary delegated mutation.
    pub fn tick(ctx: Context<Tick>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.tick = probe.tick.checked_add(1).ok_or(ProbeError::Overflow)?;
        Ok(())
    }

    /// ER. Creates the ER-local ephemeral permission, paid and signed by the delegated PDA.
    pub fn create_permission(ctx: Context<PermissionContext>) -> Result<()> {
        let signer_seeds = [
            PROBE_SEED,
            ctx.accounts.probe.authority.as_ref(),
            &[ctx.bumps.probe],
        ];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.probe.to_account_info(),
            permissioned_account: ctx.accounts.probe.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: false,
                members: vec![],
            },
        }
        .invoke_signed(&[&signer_seeds])?;
        Ok(())
    }

    /// ER. Flips the permission to private with a bounded member list.
    pub fn set_permission_private(ctx: Context<PermissionContext>, is_private: bool) -> Result<()> {
        let members = if is_private {
            vec![Member {
                flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                pubkey: ctx.accounts.probe.authority,
            }]
        } else {
            vec![]
        };
        require!(
            members.len() <= MAX_PERMISSION_MEMBERS,
            ProbeError::TooManyPermissionMembers
        );

        let signer_seeds = [
            PROBE_SEED,
            ctx.accounts.probe.authority.as_ref(),
            &[ctx.bumps.probe],
        ];
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.probe.to_account_info(),
            permissioned_account: ctx.accounts.probe.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.probe.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private,
                members,
            },
        }
        .invoke_signed(&[&signer_seeds])?;
        Ok(())
    }

    /// ER. Closes the ephemeral permission before terminal undelegation.
    pub fn close_permission(ctx: Context<PermissionContext>) -> Result<()> {
        let signer_seeds = [
            PROBE_SEED,
            ctx.accounts.probe.authority.as_ref(),
            &[ctx.bumps.probe],
        ];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.probe.to_account_info(),
            permissioned_account: ctx.accounts.probe.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.probe.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&signer_seeds])?;
        Ok(())
    }

    /// Base layer. Magic Action target. `#[action]` injects the escrow accounts.
    pub fn write_receipt(ctx: Context<WriteReceipt>, operation_id: [u8; 32]) -> Result<()> {
        let receipt = &mut ctx.accounts.receipt;
        receipt.operation_id = operation_id;
        receipt.observed = true;
        Ok(())
    }

    /// ER. Schedules a commit plus one base-layer action, paid by the user wallet.
    pub fn commit_with_action(
        ctx: Context<CommitWithAction>,
        operation_id: [u8; 32],
    ) -> Result<()> {
        let action = build_receipt_action(
            ctx.accounts.receipt.key(),
            ctx.accounts.payer.to_account_info(),
            operation_id,
        );

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.probe.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke()?;
        Ok(())
    }

    /// ER. Terminal path: commit, undelegate, and dispatch the action with the delegated
    /// PDA as both payer and escrow authority, using the sponsored-commit fee vault.
    pub fn commit_undelegate_with_action_signed(
        ctx: Context<CommitUndelegateWithActionSigned>,
        operation_id: [u8; 32],
    ) -> Result<()> {
        let authority = ctx.accounts.probe.authority;
        let bump = ctx.bumps.probe;
        let payer_seeds: &[&[u8]] = &[PROBE_SEED, authority.as_ref(), &[bump]];

        let action = build_receipt_action(
            ctx.accounts.receipt.key(),
            ctx.accounts.probe.to_account_info(),
            operation_id,
        );

        MagicIntentBundleBuilder::new(
            ctx.accounts.probe.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke_signed(&[payer_seeds])?;
        Ok(())
    }

    /// ER. Schedules a crank with the raw `MagicBlockInstruction::ScheduleTask` encoding.
    ///
    /// This mirrors `magicblock-engine-examples/crank-counter/anchor`. The SDK's
    /// `ScheduleCrankCpi` is not usable from an ordinary Anchor context because its
    /// `&'a AccountInfo<'a>` fields force the borrow to outlive `'info`; see
    /// `cancel_crank` for the shape that does satisfy it.
    pub fn schedule_crank(ctx: Context<ScheduleCrank>, args: CrankArgs) -> Result<()> {
        let inner = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.accounts.probe.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Tick {}),
        };

        let ix_data = encode_schedule_task(ScheduleTaskArgs {
            task_id: args.task_id,
            execution_interval_millis: args.execution_interval_millis,
            iterations: args.iterations,
            instructions: vec![inner],
        })?;

        let schedule_ix = Instruction::new_with_bytes(
            MAGIC_PROGRAM_ID,
            &ix_data,
            vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.probe.key(), false),
            ],
        );

        invoke(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.probe.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// ER. Cancels a crank through the SDK `CancelCrankCpi` builder.
    ///
    /// The builder's fields are `&'a AccountInfo<'a>` and `AccountInfo` is invariant in
    /// its lifetime, so the references must come from a slice that already lives for
    /// `'info`. `ctx.remaining_accounts` is such a slice; locals built from
    /// `to_account_info()` are not.
    ///
    /// remaining_accounts[0] = task authority (signer)
    /// remaining_accounts[1] = task context account
    /// remaining_accounts[2] = magic program
    pub fn cancel_crank<'info>(ctx: Context<'info, CancelCrank>, task_id: i64) -> Result<()> {
        require!(
            ctx.remaining_accounts.len() >= 3,
            ProbeError::MissingCrankAccounts
        );
        require_keys_eq!(
            ctx.remaining_accounts[2].key(),
            MAGIC_PROGRAM_ID,
            ProbeError::UnexpectedMagicProgram
        );

        CancelCrankCpi {
            authority: &ctx.remaining_accounts[0],
            task_context: &ctx.remaining_accounts[1],
            magic_program: &ctx.remaining_accounts[2],
            crank_id: task_id,
        }
        .invoke()?;
        Ok(())
    }

    /// Compile-surface check for `ScheduleCrankCpi` under the same lifetime constraint.
    ///
    /// remaining_accounts[0] = payer (signer)
    /// remaining_accounts[1] = magic program
    /// remaining_accounts[2..] = accounts the scheduled instruction touches
    pub fn schedule_crank_via_sdk<'info>(
        ctx: Context<'info, CancelCrank>,
        args: CrankArgs,
    ) -> Result<()> {
        require!(
            ctx.remaining_accounts.len() >= 3,
            ProbeError::MissingCrankAccounts
        );

        let inner = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.remaining_accounts[2].key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Tick {}),
        };

        ScheduleCrankCpi {
            payer: &ctx.remaining_accounts[0],
            magic_program: &ctx.remaining_accounts[1],
            instruction_accounts: &ctx.remaining_accounts[2..],
            args: ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![inner],
            },
        }
        .invoke()?;
        Ok(())
    }
}

/// Proves the raw `MagicBlockInstruction::ScheduleTask` bincode encoding used by the
/// current `crank-counter` example still resolves against the pinned API crate. Kept
/// outside the program module so it is a pure compile-surface check.
pub fn encode_schedule_task(args: ScheduleTaskArgs) -> std::result::Result<Vec<u8>, ProgramError> {
    bincode::serialize(&MagicBlockInstruction::ScheduleTask(args))
        .map_err(|_| ProgramError::InvalidArgument)
}

/// Proves the deterministic-hash dependency resolves in the same tree.
pub fn probe_digest(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(payload);
    hasher.finalize().into()
}

fn build_receipt_action<'info>(
    receipt: Pubkey,
    escrow_authority: AccountInfo<'info>,
    operation_id: [u8; 32],
) -> CallHandler<'info> {
    CallHandler {
        destination_program: crate::ID,
        accounts: vec![ShortAccountMeta {
            pubkey: receipt.to_bytes().into(),
            is_writable: true,
        }],
        args: ActionArgs::new(anchor_lang::InstructionData::data(
            &crate::instruction::WriteReceipt { operation_id },
        )),
        escrow_authority,
        compute_units: 200_000,
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrankArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProbeState::SIZE,
        seeds = [PROBE_SEED, authority.key().as_ref()],
        bump
    )]
    pub probe: Account<'info, ProbeState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeReceipt<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProbeReceipt::SIZE,
        seeds = [RECEIPT_SEED],
        bump
    )]
    pub receipt: Account<'info, ProbeReceipt>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateProbe<'info> {
    pub authority: Signer<'info>,
    /// CHECK: delegated by the delegation program; seeds are checked here
    #[account(mut, del, seeds = [PROBE_SEED, authority.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator, checked by the delegation program
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(mut, seeds = [PROBE_SEED, probe.authority.as_ref()], bump)]
    pub probe: Account<'info, ProbeState>,
}

#[derive(Accounts)]
pub struct PermissionContext<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PROBE_SEED, probe.authority.as_ref()],
        has_one = authority,
        bump
    )]
    pub probe: Account<'info, ProbeState>,
    /// CHECK: owned and validated by the permission program
    #[account(
        mut,
        seeds = [PERMISSION_SEED, probe.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral vault, validated by the magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Magic Action target. `#[action]` appends the `escrow_auth` and `escrow` accounts, so
/// they must not be listed in the `ShortAccountMeta` list at the call site. The receipt
/// account is created on base before scheduling; an action must not depend on `init`
/// because the injected escrow authority is not a mutable payer.
#[action]
#[derive(Accounts)]
pub struct WriteReceipt<'info> {
    #[account(mut, seeds = [RECEIPT_SEED], bump)]
    pub receipt: Account<'info, ProbeReceipt>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitWithAction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED, probe.authority.as_ref()], bump)]
    pub probe: Account<'info, ProbeState>,
    /// CHECK: writable flag is declared in the action account list, not here
    #[account(seeds = [RECEIPT_SEED], bump)]
    pub receipt: UncheckedAccount<'info>,
    /// CHECK: destination program must be present in the outer commit context
    #[account(address = crate::ID)]
    pub program_id: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitUndelegateWithActionSigned<'info> {
    #[account(mut, seeds = [PROBE_SEED, probe.authority.as_ref()], bump)]
    pub probe: Account<'info, ProbeState>,
    /// CHECK: validator-scoped fee vault, validated against the delegation record at the call site
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: writable flag is declared in the action account list, not here
    #[account(seeds = [RECEIPT_SEED], bump)]
    pub receipt: UncheckedAccount<'info>,
    /// CHECK: destination program must be present in the outer commit context
    #[account(address = crate::ID)]
    pub program_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ScheduleCrank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: passed straight to the scheduler CPI without Anchor re-serialization
    #[account(mut, seeds = [PROBE_SEED, authority.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: seed source only
    pub authority: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelCrank<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: task context account passed to the scheduler CPI
    #[account(mut, seeds = [PROBE_SEED, authority.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[account]
pub struct ProbeState {
    pub authority: Pubkey,
    pub tick: u64,
}

impl ProbeState {
    pub const SIZE: usize = 32 + 8;
}

#[account]
pub struct ProbeReceipt {
    pub operation_id: [u8; 32],
    pub observed: bool,
}

impl ProbeReceipt {
    pub const SIZE: usize = 32 + 1;
}

#[error_code]
pub enum ProbeError {
    #[msg("Probe tick counter overflowed")]
    Overflow,
    #[msg("Permission member list exceeds the funded capacity")]
    TooManyPermissionMembers,
    #[msg("Crank CPI requires payer, magic program, and target accounts")]
    MissingCrankAccounts,
    #[msg("Unexpected magic program account")]
    UnexpectedMagicProgram,
}

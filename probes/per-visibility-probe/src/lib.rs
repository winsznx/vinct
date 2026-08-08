//! An experiment, not product code.
//!
//! The question it answers: on a private ephemeral rollup, is the permission a gate on
//! *reading* an account, or on *touching* it at all?
//!
//! It matters because VINCT's sealed-quorum property depends on the answer. If a member has
//! to be inside an account's permission to submit a transaction that mutates it, then every
//! member must be inside the aggregate's permission, and every member can therefore read the
//! running tally and each other's ballots. If a transaction can mutate an account its sender
//! cannot read, the whole thing splits cleanly: one ballot account per member, each private
//! to that member, and an aggregate nobody can read at all.
//!
//! The official sealed-auction example does not settle this. Its auctioneer is a member of
//! every bid's permission and is the one who calls `end_auction`, so it never exercises a
//! caller touching an account it cannot read.
//!
//! Three account classes, deliberately minimal:
//!
//!   Aggregate   private, and its only permission member is the aggregate PDA itself, which
//!               is a key nobody holds. Nobody can authenticate as it, so nobody can read it.
//!   Ballot      private, one per member, permission member is that member alone.
//!   Anyone      a control account with no permission at all.
//!
//! Then: can member A cast a ballot, mutating both A's ballot and the unreadable aggregate?

// Anchor 1.0.2's `#[program]` expansion trips these in its generated dispatch and error
// plumbing, not in code written here.
#![allow(clippy::diverging_sub_expression)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED,
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("4bjRNqNtEnPt9WwstJkNGqDAbQGj3tu9U7gUEMEdLN1W");

pub const AGGREGATE_SEED: &[u8] = b"probe-aggregate";
pub const BALLOT_SEED: &[u8] = b"probe-ballot";

#[ephemeral]
#[program]
pub mod per_visibility_probe {
    use super::*;

    pub fn init_aggregate(ctx: Context<InitAggregate>, round: u64) -> Result<()> {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.aggregate.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32),
        )?;
        let aggregate = &mut ctx.accounts.aggregate;
        aggregate.round = round;
        aggregate.bump = ctx.bumps.aggregate;
        Ok(())
    }

    pub fn init_ballot(ctx: Context<InitBallot>, round: u64, member: Pubkey) -> Result<()> {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.ballot.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32),
        )?;
        let ballot = &mut ctx.accounts.ballot;
        ballot.round = round;
        ballot.member = member;
        ballot.bump = ctx.bumps.ballot;
        Ok(())
    }

    pub fn delegate_aggregate(ctx: Context<DelegateAggregate>, round: u64) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_aggregate(
            &ctx.accounts.payer,
            &[AGGREGATE_SEED, &round.to_le_bytes()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn delegate_ballot(ctx: Context<DelegateBallot>, round: u64, member: Pubkey) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_ballot(
            &ctx.accounts.payer,
            &[BALLOT_SEED, &round.to_le_bytes(), member.as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// The aggregate's permission names the aggregate PDA as its only member.
    ///
    /// A PDA is off the ed25519 curve, so there is no private key and nobody can complete
    /// the rollup's challenge-sign-login flow as it. The account is therefore readable by
    /// nobody. Whether it is still *writable* by a program is the experiment.
    pub fn create_unreadable_aggregate_permission(ctx: Context<AggregatePermission>) -> Result<()> {
        let round = ctx.accounts.aggregate.round;
        let seeds = [
            AGGREGATE_SEED,
            &round.to_le_bytes()[..],
            &[ctx.accounts.aggregate.bump],
        ];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.aggregate.to_account_info(),
            permissioned_account: ctx.accounts.aggregate.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: 0,
                    pubkey: ctx.accounts.aggregate.key(),
                }],
            },
        }
        .invoke_signed(&[&seeds])?;
        Ok(())
    }

    /// One ballot's permission names only that ballot's member.
    pub fn create_ballot_permission(ctx: Context<BallotPermission>) -> Result<()> {
        let round = ctx.accounts.ballot.round;
        let member = ctx.accounts.ballot.member;
        let seeds = [
            BALLOT_SEED,
            &round.to_le_bytes()[..],
            member.as_ref(),
            &[ctx.accounts.ballot.bump],
        ];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.ballot.to_account_info(),
            permissioned_account: ctx.accounts.ballot.to_account_info(),
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

    /// The experiment.
    ///
    /// The signer is a member of their own ballot's permission and of nothing else. This
    /// instruction writes their ballot and mutates the aggregate. If the rollup gates
    /// execution the way it gates reads, this cannot land.
    pub fn cast(ctx: Context<Cast>, round: u64, approve: bool) -> Result<()> {
        let _ = round;
        require_keys_eq!(
            ctx.accounts.member.key(),
            ctx.accounts.ballot.member,
            ProbeError::NotTheBallotOwner
        );
        let ballot = &mut ctx.accounts.ballot;
        ballot.approve = approve;
        ballot.cast = true;

        let aggregate = &mut ctx.accounts.aggregate;
        if approve {
            aggregate.approvals = aggregate.approvals.saturating_add(1);
        } else {
            aggregate.rejections = aggregate.rejections.saturating_add(1);
        }
        Ok(())
    }

    /// Opens the aggregate for reading, so the experiment can check the program got the
    /// arithmetic right after the fact without ever letting a member watch it happen.
    pub fn close_aggregate_permission(ctx: Context<AggregatePermission>) -> Result<()> {
        let round = ctx.accounts.aggregate.round;
        let seeds = [
            AGGREGATE_SEED,
            &round.to_le_bytes()[..],
            &[ctx.accounts.aggregate.bump],
        ];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.aggregate.to_account_info(),
            permissioned_account: ctx.accounts.aggregate.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.aggregate.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[&seeds])?;
        Ok(())
    }

    pub fn commit_aggregate(ctx: Context<CommitAggregate>, round: u64) -> Result<()> {
        let _ = round;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.aggregate.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[account]
pub struct Aggregate {
    pub round: u64,
    pub approvals: u8,
    pub rejections: u8,
    pub bump: u8,
}

impl Aggregate {
    pub const SIZE: usize = 8 + 1 + 1 + 1;
}

#[account]
pub struct Ballot {
    pub round: u64,
    pub member: Pubkey,
    pub approve: bool,
    pub cast: bool,
    pub bump: u8,
}

impl Ballot {
    pub const SIZE: usize = 8 + 32 + 1 + 1 + 1;
}

#[derive(Accounts)]
#[instruction(round: u64)]
pub struct InitAggregate<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Aggregate::SIZE,
        seeds = [AGGREGATE_SEED, &round.to_le_bytes()],
        bump
    )]
    pub aggregate: Account<'info, Aggregate>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round: u64, member: Pubkey)]
pub struct InitBallot<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Ballot::SIZE,
        seeds = [BALLOT_SEED, &round.to_le_bytes(), member.as_ref()],
        bump
    )]
    pub ballot: Account<'info, Ballot>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(round: u64)]
pub struct DelegateAggregate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated by the delegation program.
    #[account(mut, del, seeds = [AGGREGATE_SEED, &round.to_le_bytes()], bump)]
    pub aggregate: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(round: u64, member: Pubkey)]
pub struct DelegateBallot<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated by the delegation program.
    #[account(mut, del, seeds = [BALLOT_SEED, &round.to_le_bytes(), member.as_ref()], bump)]
    pub ballot: UncheckedAccount<'info>,
    /// CHECK: optional pinned validator.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct AggregatePermission<'info> {
    #[account(mut)]
    pub aggregate: Account<'info, Aggregate>,
    /// CHECK: the permission PDA.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, aggregate.key().as_ref()],
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
pub struct BallotPermission<'info> {
    #[account(mut)]
    pub ballot: Account<'info, Ballot>,
    /// CHECK: the permission PDA.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, ballot.key().as_ref()],
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
#[instruction(round: u64)]
pub struct Cast<'info> {
    pub member: Signer<'info>,
    #[account(mut, seeds = [BALLOT_SEED, &round.to_le_bytes(), member.key().as_ref()], bump = ballot.bump)]
    pub ballot: Account<'info, Ballot>,
    #[account(mut, seeds = [AGGREGATE_SEED, &round.to_le_bytes()], bump = aggregate.bump)]
    pub aggregate: Account<'info, Aggregate>,
}

#[commit]
#[derive(Accounts)]
#[instruction(round: u64)]
pub struct CommitAggregate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: decoded by the caller; untyped so Anchor does not write it back after the CPI.
    #[account(mut, seeds = [AGGREGATE_SEED, &round.to_le_bytes()], bump)]
    pub aggregate: UncheckedAccount<'info>,
}

#[error_code]
pub enum ProbeError {
    #[msg("This signer does not own that ballot")]
    NotTheBallotOwner,
}

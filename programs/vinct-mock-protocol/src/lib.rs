//! Reference lending protocol.
//!
//! Stands in for a real protocol that would join a covenant. Three independent markets
//! live under this one program, each with its own authority and its own registered adapter
//! signer. They share code the way three real protocols would share a fork of the same
//! codebase; they share no authority at all.
//!
//! The security property this program exists to demonstrate: a market accepts the
//! emergency pause from exactly one signer, the one its own authority registered, and from
//! nobody else. Not from the VINCT core program, not from the steward, not from another
//! market's adapter, and not from whoever happens to be calling.
//!
//! `reset_demo_market` is gated behind a demo authority set at initialization. It exists so
//! a judge can re-run the demonstration, and it must not appear in a production feature set.

// Anchor 1.0.2's `#[program]` expansion trips these in its generated dispatch and error
// plumbing, not in code written here. Scoped to this crate so a genuine occurrence in
// VINCT's own logic still fails the lint gate.
#![allow(clippy::diverging_sub_expression)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

declare_id!("BDUybXDdLCCbnCjthbs9NATmYZWTTKxCzqejyqyvzorS");

/// Seed for a market account.
pub const MARKET_SEED: &[u8] = b"market";

#[program]
pub mod vinct_mock_protocol {
    use super::*;

    /// Creates a market owned by `authority`.
    ///
    /// `market_id` lets one authority run several markets and, more importantly, lets three
    /// unrelated authorities coexist under one program without colliding.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        demo_authority: Option<Pubkey>,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.market_id = market_id;
        market.adapter_signer = Pubkey::default();
        market.new_borrowing_paused = false;
        market.last_operation_id = [0u8; 32];
        market.update_count = 0;
        market.demo_authority = demo_authority.unwrap_or_default();
        market.bump = ctx.bumps.market;
        Ok(())
    }

    /// Registers, replaces, or clears the one signer permitted to pause this market.
    ///
    /// Only the market's own authority may call this. That single constraint is what makes
    /// the adapter sovereign: the circle cannot install itself, and the adapter program
    /// cannot install itself either. Passing `None` revokes.
    pub fn set_adapter(ctx: Context<SetAdapter>, adapter_signer: Option<Pubkey>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.adapter_signer = adapter_signer.unwrap_or_default();
        Ok(())
    }

    /// The one bounded emergency action this protocol exposes.
    ///
    /// Idempotent per operation. A second call with the same `operation_id` is refused
    /// rather than silently ignored, so a duplicate delivery is visible instead of being
    /// absorbed. There is deliberately no unpause instruction: resuming borrowing is a
    /// protocol decision, and an emergency covenant must never be able to make it.
    pub fn pause_new_borrowing(
        ctx: Context<PauseNewBorrowing>,
        operation_id: [u8; 32],
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;

        require!(
            market.adapter_signer != Pubkey::default(),
            MockProtocolError::NoAdapterRegistered
        );
        require_keys_eq!(
            ctx.accounts.adapter_signer.key(),
            market.adapter_signer,
            MockProtocolError::UnauthorizedAdapter
        );
        require!(
            operation_id != [0u8; 32],
            MockProtocolError::ZeroOperationId
        );
        require!(
            market.last_operation_id != operation_id,
            MockProtocolError::OperationAlreadyApplied
        );

        market.new_borrowing_paused = true;
        market.last_operation_id = operation_id;
        market.update_count = market
            .update_count
            .checked_add(1)
            .ok_or(MockProtocolError::UpdateCountOverflow)?;

        emit!(NewBorrowingPaused {
            market: market.key(),
            operation_id,
            update_count: market.update_count,
        });
        Ok(())
    }

    /// Resets a market so the demonstration can be re-run.
    ///
    /// Demo-only. Requires the demo authority set at initialization, which is a different
    /// key from the market authority so that turning the demo path off is a matter of
    /// initializing with `None`.
    pub fn reset_demo_market(ctx: Context<ResetDemoMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(
            market.demo_authority != Pubkey::default(),
            MockProtocolError::DemoResetDisabled
        );
        market.new_borrowing_paused = false;
        market.last_operation_id = [0u8; 32];
        market.update_count = 0;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolMarket::SIZE,
        seeds = [MARKET_SEED, authority.key().as_ref(), &market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, ProtocolMarket>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAdapter<'info> {
    #[account(mut, has_one = authority @ MockProtocolError::UnauthorizedAuthority)]
    pub market: Account<'info, ProtocolMarket>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PauseNewBorrowing<'info> {
    #[account(mut)]
    pub market: Account<'info, ProtocolMarket>,
    /// CHECK: compared against `market.adapter_signer` and required to sign. The protocol
    /// authorises one specific signer, never a program, so a different adapter program that
    /// happens to derive the same context cannot substitute itself.
    pub adapter_signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResetDemoMarket<'info> {
    #[account(
        mut,
        constraint = market.demo_authority == demo_authority.key() @ MockProtocolError::UnauthorizedDemoAuthority
    )]
    pub market: Account<'info, ProtocolMarket>,
    pub demo_authority: Signer<'info>,
}

/// One protocol's market state.
#[account]
pub struct ProtocolMarket {
    /// The protocol's own authority. Only this key may register an adapter.
    pub authority: Pubkey,
    /// Distinguishes markets under one authority.
    pub market_id: u64,
    /// The one signer permitted to pause. Default means no adapter is registered.
    pub adapter_signer: Pubkey,
    /// Whether new borrowing is paused.
    pub new_borrowing_paused: bool,
    /// The last operation applied, for idempotency.
    pub last_operation_id: [u8; 32],
    /// How many times the pause has been applied.
    pub update_count: u64,
    /// Demo reset authority. Default disables the reset path entirely.
    pub demo_authority: Pubkey,
    /// PDA bump.
    pub bump: u8,
}

impl ProtocolMarket {
    /// Serialized size, excluding the 8-byte discriminator.
    pub const SIZE: usize = 32 + 8 + 32 + 1 + 32 + 8 + 32 + 1;
}

#[event]
pub struct NewBorrowingPaused {
    pub market: Pubkey,
    pub operation_id: [u8; 32],
    pub update_count: u64,
}

#[error_code]
pub enum MockProtocolError {
    #[msg("This market has no registered adapter")]
    NoAdapterRegistered,
    #[msg("Signer is not this market's registered adapter")]
    UnauthorizedAdapter,
    #[msg("Only the market authority may perform this action")]
    UnauthorizedAuthority,
    #[msg("Only the demo authority may reset this market")]
    UnauthorizedDemoAuthority,
    #[msg("Demo reset is disabled for this market")]
    DemoResetDisabled,
    #[msg("Operation ID must not be zero")]
    ZeroOperationId,
    #[msg("This operation was already applied to this market")]
    OperationAlreadyApplied,
    #[msg("Update count overflowed")]
    UpdateCountOverflow,
}

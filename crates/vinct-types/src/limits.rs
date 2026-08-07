//! Hard bounds on every variable-length structure.
//!
//! Unbounded vectors are an account-size and compute hazard on Solana, and an
//! availability hazard everywhere else. Every limit here is enforced by a validator in
//! the type that owns it, not merely documented.
//!
//! The numbers are deliberately small. The hackathon covenant is three members and four
//! actions; the headroom exists so a covenant can grow without a new account layout, not
//! because large covenants are supported.

/// Maximum members in one covenant epoch.
pub const MAX_MEMBERS: usize = 16;

/// Maximum response policies attached to one covenant epoch.
pub const MAX_POLICIES: usize = 8;

/// Maximum actions in one action bundle.
///
/// The reference cohort is three adapter actions plus one settlement receipt action.
/// Anything beyond eight will not fit a single base transaction alongside the commit,
/// which Phase 3 measures rather than assumes.
pub const MAX_ACTIONS: usize = 8;

/// Maximum account metas in one action.
pub const MAX_ACCOUNT_METAS: usize = 16;

/// Maximum instruction data bytes in one action.
pub const MAX_INSTRUCTION_DATA: usize = 256;

/// Maximum bytes in any single private incident payload.
pub const MAX_PRIVATE_PAYLOAD: usize = 1024;

/// Maximum members on one ER-local ephemeral permission.
///
/// The delegated account is pre-funded on base for exactly this many permission members,
/// so every create and update path must enforce it or the permission cannot pay its rent.
pub const MAX_PERMISSION_MEMBERS: usize = 8;

//! Canonical VINCT types.
//!
//! One Rust implementation is authoritative for every VINCT digest. This crate is it.
//! It has no Anchor dependency, no Solana runtime dependency, and no network access, so
//! the same code runs inside a program, in a host test, and in the vector generator that
//! feeds the TypeScript verifier.
//!
//! Rules this crate enforces rather than documents:
//!
//! - SHA-256 over Borsh, never JSON canonicalisation and never string concatenation
//! - an explicit domain separator as the first field of every hashed struct
//! - versioned struct names, so a `V2` can never be decoded as a `V1`
//! - exact Solana instruction order for account metas, which are never sorted
//! - bounded vectors with the bound enforced by a validator
//! - checked arithmetic
//! - explicit errors

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod action;
pub mod address;
pub mod attestation;
pub mod certificate;
pub mod covenant;
pub mod domains;
pub mod error;
pub mod hash;
pub mod incident;
pub mod limits;
pub mod policy;
pub mod recovery;
pub mod settlement;
pub mod zeroize;

pub use address::Address;
pub use error::VinctTypesError;
pub use hash::Digest32;

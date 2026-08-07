//! A 32-byte account address.
//!
//! VINCT's canonical types must hash identically inside an on-chain program, in a
//! host-side test, and in a TypeScript verifier. Depending on `solana-program` here
//! would drag a runtime into the reference model, so the canonical form is a plain
//! 32-byte newtype. Programs convert at their boundary.

use borsh::{BorshDeserialize, BorshSerialize};
use core::fmt;

/// A 32-byte account address, Borsh-encoded as exactly 32 raw bytes.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Address(pub [u8; 32]);

impl Address {
    /// The all-zero address. Used as the placeholder in account-meta templates whose
    /// concrete address is only known once an operation ID exists.
    pub const ZERO: Address = Address([0u8; 32]);

    /// Borrows the raw bytes.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Returns the raw bytes.
    pub const fn to_bytes(self) -> [u8; 32] {
        self.0
    }

    /// True when every byte is zero.
    pub fn is_zero(&self) -> bool {
        self.0 == [0u8; 32]
    }

    /// Builds a deterministic address from a small integer.
    ///
    /// Test and vector-generation helper only. It produces a recognisable, stable
    /// address without needing a keypair or a curve implementation.
    pub const fn from_seed(seed: u8) -> Address {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        bytes[31] = seed;
        Address(bytes)
    }
}

impl From<[u8; 32]> for Address {
    fn from(value: [u8; 32]) -> Self {
        Address(value)
    }
}

impl From<Address> for [u8; 32] {
    fn from(value: Address) -> Self {
        value.0
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Address(")?;
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        write!(f, ")")
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

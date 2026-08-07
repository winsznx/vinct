//! The zeroization gate.
//!
//! The delegated incident account holds protected fields while it lives inside the PER.
//! Committing or undelegating it publishes its bytes to the base layer forever, so every
//! instruction capable of either must refuse unless every protected field has been
//! overwritten and the flag set.
//!
//! The flag is not the guarantee; the byte check is. [`ZeroizableBytes::is_zeroized`]
//! inspects the buffer rather than trusting a boolean, and
//! [`ZeroizationState::may_commit`] requires both.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::VinctTypesError;
use crate::limits::MAX_PRIVATE_PAYLOAD;

/// A bounded private byte buffer that can be overwritten in place.
///
/// The length is preserved on zeroization. Shrinking the buffer to zero would leak how
/// much evidence an incident carried through the account's serialized size, so the bytes
/// go to zero and the length stays.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct ZeroizableBytes {
    /// The buffer. All zero once zeroized.
    pub bytes: Vec<u8>,
}

impl ZeroizableBytes {
    /// Wraps a payload, enforcing the bound.
    pub fn new(bytes: Vec<u8>) -> Result<Self, VinctTypesError> {
        if bytes.len() > MAX_PRIVATE_PAYLOAD {
            return Err(VinctTypesError::PrivatePayloadTooLong);
        }
        Ok(Self { bytes })
    }

    /// An empty buffer.
    pub fn empty() -> Self {
        Self { bytes: Vec::new() }
    }

    /// Overwrites every byte with zero, keeping the length.
    pub fn zeroize(&mut self) {
        for byte in self.bytes.iter_mut() {
            *byte = 0;
        }
    }

    /// True when no byte is non-zero.
    pub fn is_zeroized(&self) -> bool {
        self.bytes.iter().all(|byte| *byte == 0)
    }

    /// Number of bytes held.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// True when the buffer holds nothing.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// Why a commit or undelegation was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZeroizationRefusal {
    /// The flag was never set.
    FlagNotSet,
    /// The private claim buffer still holds non-zero bytes.
    ClaimNotZeroized,
    /// At least one attestation record survives.
    AttestationsRemain,
    /// The observation window still holds non-zero bytes.
    ObservationWindowNotZeroized,
    /// The responder notes buffer still holds non-zero bytes.
    NotesNotZeroized,
}

/// The zeroization state of one incident account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroizationState {
    /// Whether the private claim buffer is fully zero.
    pub claim_zeroized: bool,
    /// Whether every attestation record has been dropped.
    pub attestations_cleared: bool,
    /// Whether the observation window buffer is fully zero.
    pub observation_window_zeroized: bool,
    /// Whether the responder notes buffer is fully zero.
    pub notes_zeroized: bool,
    /// The account's own `private_fields_zeroized` flag.
    pub flag: bool,
}

impl ZeroizationState {
    /// The state of an account that has not been scrubbed.
    pub const DIRTY: ZeroizationState = ZeroizationState {
        claim_zeroized: false,
        attestations_cleared: false,
        observation_window_zeroized: false,
        notes_zeroized: false,
        flag: false,
    };

    /// The state of a fully scrubbed account.
    pub const CLEAN: ZeroizationState = ZeroizationState {
        claim_zeroized: true,
        attestations_cleared: true,
        observation_window_zeroized: true,
        notes_zeroized: true,
        flag: true,
    };

    /// Returns `Ok(())` only when every protected field is provably gone.
    ///
    /// The order of checks is deliberate: the byte-level facts are examined before the
    /// flag, so a program that sets the flag without scrubbing is reported as the
    /// specific field it left behind rather than as a generic flag error.
    pub fn may_commit(&self) -> Result<(), ZeroizationRefusal> {
        if !self.claim_zeroized {
            return Err(ZeroizationRefusal::ClaimNotZeroized);
        }
        if !self.attestations_cleared {
            return Err(ZeroizationRefusal::AttestationsRemain);
        }
        if !self.observation_window_zeroized {
            return Err(ZeroizationRefusal::ObservationWindowNotZeroized);
        }
        if !self.notes_zeroized {
            return Err(ZeroizationRefusal::NotesNotZeroized);
        }
        if !self.flag {
            return Err(ZeroizationRefusal::FlagNotSet);
        }
        Ok(())
    }
}

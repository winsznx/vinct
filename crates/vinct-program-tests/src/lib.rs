//! Shared scaffolding for the VINCT program tests.
//!
//! This crate deliberately does not depend on any VINCT program as a library. Every
//! instruction is assembled from raw bytes, the way an attacker would assemble one, so a
//! test can build account lists and instruction data the programs' own helpers would never
//! emit. A harness that could only produce well-formed input would not be able to prove
//! that malformed input is rejected.

use sha2::{Digest, Sha256};

/// Anchor's instruction discriminator: the first eight bytes of `sha256("global:<name>")`.
///
/// Recomputed here rather than imported so a change to Anchor's scheme shows up as a test
/// failure rather than being silently followed.
pub fn instruction_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

/// Anchor's account discriminator: the first eight bytes of `sha256("account:<Name>")`.
pub fn account_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("account:{name}").as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

/// Builds Anchor instruction data: discriminator followed by Borsh-encoded arguments.
pub fn instruction_data<T: borsh::BorshSerialize>(name: &str, args: &T) -> Vec<u8> {
    let mut data = instruction_discriminator(name).to_vec();
    data.extend_from_slice(&borsh::to_vec(args).expect("args serialize"));
    data
}

/// Instruction data for an instruction that takes no arguments.
pub fn instruction_data_empty(name: &str) -> Vec<u8> {
    instruction_discriminator(name).to_vec()
}

/// SHA-256 of a byte slice.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// The commitment the adapter recomputes over its own ordered account metas.
///
/// Mirrors `hash_ordered_account_metas` in the adapter, byte for byte. It is reimplemented
/// here on purpose: if the adapter changes its layout or its hashing, the mismatch surfaces
/// as a test failure rather than as two implementations quietly agreeing on something new.
pub fn ordered_account_metas_hash(metas: &[([u8; 32], bool, bool)]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update((metas.len() as u32).to_le_bytes());
    for (key, is_signer, is_writable) in metas {
        hasher.update(key);
        hasher.update([u8::from(*is_signer)]);
        hasher.update([u8::from(*is_writable)]);
    }
    hasher.finalize().into()
}

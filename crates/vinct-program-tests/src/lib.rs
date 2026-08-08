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

/// One slot in an armed action template.
///
/// Roles are the adapter's Borsh discriminants for `AccountRoleV1`, which is a closed enum in
/// `vinct_types`. There is no variant a test could invent that the adapter would honour.
#[derive(Clone, Copy, Debug)]
pub enum TemplateSlot {
    /// An address the protocol authority pinned when it armed.
    Fixed([u8; 32], bool, bool),
    /// The adapter receipt for whichever operation is executing.
    AdapterReceipt(bool, bool),
    /// The certificate for whichever operation is executing.
    Certificate(bool, bool),
}

/// The commitment a protocol authority signs when it arms its adapter.
///
/// Mirrors `hash_action_template` in the adapter, byte for byte, and is reimplemented here on
/// purpose: if the adapter changes its layout or its hashing, the mismatch surfaces as a test
/// failure rather than as two implementations quietly agreeing on something new.
///
/// The derived slots contribute their role and their flags and no address, which is what lets
/// one armed capability serve every future operation under its covenant.
pub fn action_template_hash(slots: &[TemplateSlot]) -> [u8; 32] {
    const ROLE_FIXED: u8 = 0;
    const ROLE_ADAPTER_RECEIPT: u8 = 1;
    const ROLE_CERTIFICATE: u8 = 3;

    let mut hasher = Sha256::new();
    hasher.update((slots.len() as u32).to_le_bytes());
    for slot in slots {
        let (role, key, is_signer, is_writable) = match slot {
            TemplateSlot::Fixed(key, signer, writable) => (ROLE_FIXED, *key, *signer, *writable),
            TemplateSlot::AdapterReceipt(signer, writable) => {
                (ROLE_ADAPTER_RECEIPT, [0u8; 32], *signer, *writable)
            }
            TemplateSlot::Certificate(signer, writable) => {
                (ROLE_CERTIFICATE, [0u8; 32], *signer, *writable)
            }
        };
        hasher.update([role]);
        hasher.update(key);
        hasher.update([u8::from(is_signer)]);
        hasher.update([u8::from(is_writable)]);
    }
    hasher.finalize().into()
}

//! Domain-separated SHA-256 over Borsh.
//!
//! Every canonical VINCT digest follows the same rule: a versioned struct whose first
//! field is a 32-byte domain separator, Borsh-serialised, then SHA-256'd. There is no
//! JSON canonicalisation and no string concatenation anywhere in the hash path.
//!
//! The domain separator is itself `sha256(label)`, so two structs can never collide by
//! having the same field layout under different labels.

use borsh::BorshSerialize;
use sha2::{Digest, Sha256};

use crate::error::VinctTypesError;

/// A 32-byte digest.
pub type Digest32 = [u8; 32];

/// SHA-256 of a byte slice.
pub fn sha256(bytes: &[u8]) -> Digest32 {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// Derives a domain separator from its label.
///
/// `const` is deliberately not used: the separators are computed once at first use and
/// asserted against committed vectors, so a label typo shows up as a vector mismatch
/// rather than as a silently different hash.
pub fn domain(label: &str) -> Digest32 {
    sha256(label.as_bytes())
}

/// Borsh-serialises a value and returns its SHA-256.
///
/// The value is expected to already carry its domain separator as its first field.
pub fn hash_borsh<T: BorshSerialize>(value: &T) -> Result<Digest32, VinctTypesError> {
    let bytes = borsh::to_vec(value).map_err(|_| VinctTypesError::SerializationFailed)?;
    Ok(sha256(&bytes))
}

/// Borsh-serialises a value, returning both its bytes and its digest.
///
/// Vector generation needs the bytes so the TypeScript verifier can be checked against
/// the exact preimage, not just the digest.
pub fn preimage_and_hash<T: BorshSerialize>(
    value: &T,
) -> Result<(Vec<u8>, Digest32), VinctTypesError> {
    let bytes = borsh::to_vec(value).map_err(|_| VinctTypesError::SerializationFailed)?;
    let digest = sha256(&bytes);
    Ok((bytes, digest))
}

/// Deserialises a value and rejects any trailing bytes.
///
/// Borsh's `try_from_slice` already rejects trailing data, but VINCT depends on that
/// property for replay resistance, so it is asserted here behind an explicit error and
/// covered by a dedicated test rather than assumed from the dependency.
pub fn from_slice_exact<T: borsh::BorshDeserialize>(bytes: &[u8]) -> Result<T, VinctTypesError> {
    let mut cursor = bytes;
    let value = T::deserialize(&mut cursor).map_err(|_| VinctTypesError::DeserializationFailed)?;
    if !cursor.is_empty() {
        return Err(VinctTypesError::TrailingBytes);
    }
    Ok(value)
}

/// Hashes an ordered list of digests under its own domain separator.
///
/// Used for set commitments such as the member set and the policy set. Order is
/// significant and is never normalised by this function; callers that need a
/// canonical order impose it before calling, and callers that must preserve caller
/// order (account metas, action order) rely on that being the case.
pub fn hash_digest_list(domain_separator: &Digest32, items: &[Digest32]) -> Digest32 {
    let mut hasher = Sha256::new();
    hasher.update(domain_separator);
    hasher.update((items.len() as u32).to_le_bytes());
    for item in items {
        hasher.update(item);
    }
    hasher.finalize().into()
}

//! Domain separator labels.
//!
//! Each label names one struct at one version. Changing a struct's fields requires a new
//! label and a new `V2` type; it never reuses a `V1` label, because a verifier holding an
//! old vector must fail loudly rather than decode new bytes into an old shape.

/// Covenant digest, version 1.
pub const COVENANT_V1: &str = "VINCT_COVENANT_V1";

/// Member set commitment, version 1.
pub const MEMBER_SET_V1: &str = "VINCT_MEMBER_SET_V1";

/// Single member commitment, version 1.
pub const MEMBER_V1: &str = "VINCT_MEMBER_V1";

/// Response policy commitment, version 1.
pub const POLICY_V1: &str = "VINCT_POLICY_V1";

/// Policy set commitment, version 1.
pub const POLICY_SET_V1: &str = "VINCT_POLICY_SET_V1";

/// Adapter set commitment, version 1.
pub const ADAPTER_SET_V1: &str = "VINCT_ADAPTER_SET_V1";

/// Registered action bundle template, version 1.
pub const ACTION_TEMPLATE_V1: &str = "VINCT_ACTION_TEMPLATE_V1";

/// Concrete action bundle, version 1.
pub const ACTION_BUNDLE_V1: &str = "VINCT_ACTION_BUNDLE_V1";

/// Operation identity, version 1.
pub const OPERATION_V1: &str = "VINCT_OPERATION_V1";

/// Incident certificate, version 1.
pub const CERTIFICATE_V1: &str = "VINCT_CERTIFICATE_V1";

/// Sealed attestation commitment, version 1.
pub const ATTESTATION_V1: &str = "VINCT_ATTESTATION_V1";

/// Private incident claim commitment, version 1.
pub const INCIDENT_CLAIM_V1: &str = "VINCT_INCIDENT_CLAIM_V1";

/// Recovery operation identity, version 1.
pub const RECOVERY_V1: &str = "VINCT_RECOVERY_V1";

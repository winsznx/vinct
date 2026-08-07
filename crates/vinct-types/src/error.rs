//! Explicit errors. No generic `InvalidArgument` anywhere in this crate.

use core::fmt;

/// Everything the canonical type layer can reject.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VinctTypesError {
    /// Borsh serialisation failed.
    SerializationFailed,
    /// Borsh deserialisation failed.
    DeserializationFailed,
    /// Bytes remained after a complete value was decoded.
    TrailingBytes,
    /// The member set is empty.
    EmptyMemberSet,
    /// The member set exceeds [`crate::limits::MAX_MEMBERS`].
    TooManyMembers,
    /// The same member address appears twice in one member set.
    DuplicateMember,
    /// Member addresses are not in strictly ascending order.
    MemberSetNotCanonicallyOrdered,
    /// The action bundle is empty.
    EmptyActionBundle,
    /// The action bundle exceeds [`crate::limits::MAX_ACTIONS`].
    TooManyActions,
    /// Action indices are not the contiguous sequence `0..len`.
    ActionIndexNotSequential,
    /// The same action index appears twice.
    DuplicateActionIndex,
    /// An action carries no account metas.
    EmptyAccountMetas,
    /// An action exceeds [`crate::limits::MAX_ACCOUNT_METAS`].
    TooManyAccountMetas,
    /// Instruction data exceeds [`crate::limits::MAX_INSTRUCTION_DATA`].
    InstructionDataTooLong,
    /// A required approval count of zero would certify without any approval.
    ZeroRequiredApprovals,
    /// The required approval count exceeds the eligible member count.
    ThresholdExceedsMemberCount,
    /// A response window of zero slots can never collect an attestation.
    ZeroResponseWindow,
    /// A certificate lifetime of zero slots expires before it can settle.
    ZeroCertificateLifetime,
    /// A template account meta declared a non-fixed role but carried an address.
    TemplateRoleAddressMismatch,
    /// Resolving a template needed an address the caller did not supply.
    UnresolvedTemplateAddress,
    /// A resolved address was all zero.
    ZeroResolvedAddress,
    /// Arithmetic would have overflowed.
    ArithmeticOverflow,
    /// A private payload exceeds [`crate::limits::MAX_PRIVATE_PAYLOAD`].
    PrivatePayloadTooLong,
}

impl fmt::Display for VinctTypesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::SerializationFailed => "borsh serialization failed",
            Self::DeserializationFailed => "borsh deserialization failed",
            Self::TrailingBytes => "trailing bytes after a complete value",
            Self::EmptyMemberSet => "member set is empty",
            Self::TooManyMembers => "member set exceeds the maximum",
            Self::DuplicateMember => "duplicate member address",
            Self::MemberSetNotCanonicallyOrdered => "member set is not in ascending address order",
            Self::EmptyActionBundle => "action bundle is empty",
            Self::TooManyActions => "action bundle exceeds the maximum",
            Self::ActionIndexNotSequential => "action indices are not contiguous from zero",
            Self::DuplicateActionIndex => "duplicate action index",
            Self::EmptyAccountMetas => "action has no account metas",
            Self::TooManyAccountMetas => "action exceeds the account meta maximum",
            Self::InstructionDataTooLong => "instruction data exceeds the maximum",
            Self::ZeroRequiredApprovals => "required approvals is zero",
            Self::ThresholdExceedsMemberCount => "required approvals exceeds eligible members",
            Self::ZeroResponseWindow => "response window is zero slots",
            Self::ZeroCertificateLifetime => "certificate lifetime is zero slots",
            Self::TemplateRoleAddressMismatch => "template account role and address disagree",
            Self::UnresolvedTemplateAddress => "template needed an address the caller omitted",
            Self::ZeroResolvedAddress => "resolved address is all zero",
            Self::ArithmeticOverflow => "arithmetic overflow",
            Self::PrivatePayloadTooLong => "private payload exceeds the maximum",
        };
        f.write_str(message)
    }
}

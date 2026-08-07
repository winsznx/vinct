//! The VINCT reference model.
//!
//! This crate is the specification. It is deterministic, has no hidden clock, no
//! randomness, no floating point, and no network access. Every time-dependent decision
//! takes an explicit `now_slot`.
//!
//! Production integration tests compare their results against this crate. They do not
//! reimplement expected values, because two implementations of the same rule drift and
//! the drift is only discovered during an incident.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod certify;
pub mod evaluate;
pub mod fixtures;
pub mod model;
pub mod recover;

pub use certify::{certify, CertificationError, CertifiedOperation};
pub use evaluate::{
    evaluate_incident, public_view, quarantine_member, submit_attestation, EvaluationError,
    EvaluationOutcome, EvaluationResult, PublicIncidentView, Tally,
};
pub use model::{CovenantSnapshot, IncidentState};
pub use recover::{propose_recovery, RecoveryProposalInputs};

/// Re-exported so downstream code has exactly one source for canonical types.
pub use vinct_types;

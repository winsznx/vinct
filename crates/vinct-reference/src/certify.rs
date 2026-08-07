//! Certification: turning a met threshold into one certificate bound to one bundle.

use vinct_types::action::{
    operation_id, resolve_bundle, ActionBundleV1, OperationInputsV1, ResolvedAddressesV1,
};
use vinct_types::certificate::CertificateV1;
use vinct_types::hash::Digest32;
use vinct_types::zeroize::{ZeroizationRefusal, ZeroizationState};

use crate::evaluate::{evaluate_incident, EvaluationError, EvaluationOutcome};
use crate::model::{CovenantSnapshot, IncidentState};

/// Why certification was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertificationError {
    /// The threshold has not been met.
    ThresholdNotMet,
    /// The incident is already past the point where a certificate can be issued.
    IncidentNotCertifiable,
    /// The private fields have not been scrubbed, so nothing may be published.
    NotZeroized(ZeroizationRefusal),
    /// Evaluation refused.
    Evaluation(EvaluationError),
    /// A canonical type refused.
    Types(vinct_types::VinctTypesError),
}

/// A certificate and the exact bundle it authorises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertifiedOperation {
    /// The certificate.
    pub certificate: CertificateV1,
    /// The concrete bundle. Its hash is on the certificate.
    pub bundle: ActionBundleV1,
    /// The operation identity every effect is idempotent against.
    pub operation_id: Digest32,
    /// The certificate's own hash.
    pub certificate_hash: Digest32,
    /// The bundle's hash.
    pub action_bundle_hash: Digest32,
}

/// Issues a certificate for an incident whose threshold has been met.
///
/// The zeroization state is an input, not an afterthought. Certification is the moment
/// public fields are finalised, and the PRD requires the private fields to be gone before
/// any of it can commit, so a dirty account cannot produce a certificate at all.
///
/// The operation ID is derived first, from inputs that exist before any concrete bundle.
/// Receipt addresses are then resolved against it, and only then is the bundle built and
/// hashed. That ordering is what removes the circular derivation in the PRD; see
/// `docs/decision-log.md` entry D-0012.
#[allow(clippy::too_many_arguments)]
pub fn certify(
    covenant: &CovenantSnapshot,
    incident: &IncidentState,
    zeroization: ZeroizationState,
    certificate_nonce: u64,
    capability_nonces: &[u64],
    resolved: &ResolvedAddressesV1,
    now_slot: u64,
) -> Result<CertifiedOperation, CertificationError> {
    if !incident.status.accepts_attestations() {
        return Err(CertificationError::IncidentNotCertifiable);
    }

    let evaluation =
        evaluate_incident(covenant, incident, now_slot).map_err(CertificationError::Evaluation)?;
    if evaluation.outcome != EvaluationOutcome::Certified {
        return Err(CertificationError::ThresholdNotMet);
    }

    zeroization
        .may_commit()
        .map_err(CertificationError::NotZeroized)?;

    let inputs = OperationInputsV1 {
        cluster_genesis_hash: incident.snapshot.cluster_genesis_hash,
        covenant: incident.snapshot.covenant,
        circle_epoch: incident.snapshot.circle_epoch,
        incident_id: incident.snapshot.incident_id,
        policy_id: incident.snapshot.policy_id,
        member_set_hash: incident.snapshot.member_set_hash,
        action_bundle_template_hash: incident.snapshot.action_bundle_template_hash,
        certificate_nonce,
    };
    let operation = operation_id(&inputs);

    let expires_at_slot = now_slot
        .checked_add(covenant.policy.certificate_ttl_slots)
        .ok_or(CertificationError::Types(
            vinct_types::VinctTypesError::ArithmeticOverflow,
        ))?;

    let bundle = resolve_bundle(
        &covenant.template,
        incident.snapshot.cluster_genesis_hash,
        incident.snapshot.covenant,
        incident.snapshot.circle_epoch,
        incident.snapshot.incident_id,
        incident.snapshot.policy_id,
        incident.snapshot.member_set_hash,
        expires_at_slot,
        operation,
        capability_nonces,
        resolved,
    )
    .map_err(CertificationError::Types)?;

    let action_bundle_hash = bundle.hash().map_err(CertificationError::Types)?;

    let certificate = CertificateV1::new(
        incident.snapshot.cluster_genesis_hash,
        incident.snapshot.covenant,
        incident.snapshot.circle_epoch,
        incident.snapshot.incident_id,
        incident.snapshot.policy_id,
        incident.snapshot.member_set_hash,
        action_bundle_hash,
        operation,
        certificate_nonce,
        evaluation.tally.approvals,
        evaluation.tally.rejections,
        now_slot,
        expires_at_slot,
    );
    let certificate_hash = certificate.hash().map_err(CertificationError::Types)?;

    Ok(CertifiedOperation {
        certificate,
        bundle,
        operation_id: operation,
        certificate_hash,
        action_bundle_hash,
    })
}

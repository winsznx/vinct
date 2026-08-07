//! Settlement observation and classification.
//!
//! This module exists because a Magic Action scheduling signature proves that an intent
//! was accepted and nothing more. Within one attempted base transaction the commit and
//! its actions are atomic, but a failing BaseAction can cause the committor to remove
//! every BaseAction in that transaction strategy and retry the remaining commit work. A
//! later successful commit is therefore not evidence that any action ran.
//!
//! Nothing here infers an effect. Every input is an independent observation of base-layer
//! state, and the absence of an observation is [`ObservationV1::NotObserved`], never a
//! silent false.

use borsh::{BorshDeserialize, BorshSerialize};

use crate::hash::Digest32;

/// What an observer established about one expected effect.
///
/// The distinction between `NotObserved` and `Absent` is load-bearing. `NotObserved`
/// means the observer could not read the account. `Absent` means it read it and the
/// effect is not there. Collapsing them would turn an RPC outage into a false
/// `CommitWithoutActions` and then into an unnecessary recovery operation.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservationV1 {
    /// Read successfully; the effect is present and matches the operation.
    Present,
    /// Read successfully; the effect is not there.
    Absent,
    /// Could not be read. Provider or RPC evidence is insufficient.
    NotObserved,
}

/// Where one expected action sits in its delivery lifecycle.
///
/// Mirrors PRD section 11.5.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionDeliveryState {
    /// Registered in the bundle, not yet scheduled.
    Expected,
    /// Included in an accepted ER intent.
    Scheduled,
    /// A base-layer attempt containing it was observed.
    AttemptObserved,
    /// Its effect and receipt were observed on base.
    Applied,
    /// The attempt containing it reverted.
    Reverted,
    /// The committor removed it from the transaction strategy before retrying.
    RemovedBeforeRetry,
    /// Its outcome could not be established.
    Unknown,
}

/// One expected action's observation record.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActionObservationV1 {
    /// Position in covenant registration order.
    pub action_index: u16,
    /// Whether the adapter wrote its receipt.
    pub receipt: ObservationV1,
    /// Whether the target protocol's state actually changed as intended.
    pub target_effect: ObservationV1,
    /// The delivery state the reconciler assigned.
    pub delivery_state: ActionDeliveryState,
}

impl ActionObservationV1 {
    /// True when both the receipt and the target effect were seen.
    ///
    /// A receipt alone is not enough. An adapter could write a receipt and have its CPI
    /// fail in a design that swallowed the error, so the target's own state is checked
    /// independently.
    pub fn is_applied(&self) -> bool {
        self.receipt == ObservationV1::Present && self.target_effect == ObservationV1::Present
    }

    /// True when the observer positively established that nothing happened.
    pub fn is_absent(&self) -> bool {
        self.receipt == ObservationV1::Absent && self.target_effect == ObservationV1::Absent
    }

    /// True when any part of this action's outcome could not be read.
    pub fn is_unknown(&self) -> bool {
        self.receipt == ObservationV1::NotObserved
            || self.target_effect == ObservationV1::NotObserved
    }
}

/// The reconciler's verdict on one operation.
///
/// Mirrors PRD section 19.2.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementClassification {
    /// Every adapter receipt, every target effect, and the settlement receipt observed.
    AllActionsApplied,
    /// The scrubbed checkpoint committed but no required action effect exists.
    CommitWithoutActions,
    /// Some required effects exist and the cohort is incomplete. A critical invariant
    /// failure: one intended cohort should share one transaction outcome.
    PartialObservation,
    /// Evidence is insufficient to classify.
    Unknown,
}

/// Everything the reconciler read about one operation.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SettlementObservationV1 {
    /// The operation being reconciled.
    pub operation_id: Digest32,
    /// Whether the scrubbed certificate checkpoint reached base.
    pub certificate_checkpoint: ObservationV1,
    /// Whether the final settlement receipt reached base.
    pub settlement_receipt: ObservationV1,
    /// One record per expected action, in covenant order.
    pub actions: Vec<ActionObservationV1>,
}

/// Classifies one operation from observations alone.
///
/// The order of the branches is the order of certainty. `AllActionsApplied` requires
/// positive evidence of every effect. `CommitWithoutActions` requires positive evidence
/// that the checkpoint landed *and* positive evidence that nothing else did. Anything
/// mixed is `PartialObservation`, and anything unreadable is `Unknown`.
///
/// There is deliberately no branch that treats "most effects applied" as success.
pub fn classify(observation: &SettlementObservationV1) -> SettlementClassification {
    if observation.actions.is_empty() {
        return SettlementClassification::Unknown;
    }

    let any_unknown = observation.certificate_checkpoint == ObservationV1::NotObserved
        || observation.settlement_receipt == ObservationV1::NotObserved
        || observation.actions.iter().any(|a| a.is_unknown());

    let all_applied = observation.settlement_receipt == ObservationV1::Present
        && observation.actions.iter().all(|a| a.is_applied());
    if all_applied {
        return SettlementClassification::AllActionsApplied;
    }

    let none_applied = observation.settlement_receipt == ObservationV1::Absent
        && observation.actions.iter().all(|a| a.is_absent());
    if none_applied && observation.certificate_checkpoint == ObservationV1::Present {
        return SettlementClassification::CommitWithoutActions;
    }

    if any_unknown {
        return SettlementClassification::Unknown;
    }

    let any_applied = observation.settlement_receipt == ObservationV1::Present
        || observation.actions.iter().any(|a| a.is_applied());
    if any_applied {
        return SettlementClassification::PartialObservation;
    }

    SettlementClassification::Unknown
}

/// Maps a classification onto the incident status it justifies.
///
/// `AllActionsApplied` is the only path to `Settled`. Every other classification leaves
/// the incident in a state that says out loud what is and is not known.
pub fn status_for(classification: SettlementClassification) -> crate::incident::IncidentStatus {
    use crate::incident::IncidentStatus;
    match classification {
        SettlementClassification::AllActionsApplied => IncidentStatus::Settled,
        SettlementClassification::CommitWithoutActions => IncidentStatus::CommitWithoutActions,
        SettlementClassification::PartialObservation => IncidentStatus::ReconciliationRequired,
        SettlementClassification::Unknown => IncidentStatus::SettlementUnknown,
    }
}

/// True when a classification permits opening a governed recovery proposal.
///
/// `PartialObservation` deliberately blocks automated recovery. A cohort that half-applied
/// means an assumption about transaction-strategy grouping was wrong, and re-running any
/// part of it before a human understands why risks a duplicate effect.
pub fn permits_recovery(classification: SettlementClassification) -> bool {
    matches!(
        classification,
        SettlementClassification::CommitWithoutActions
    )
}

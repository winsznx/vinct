/**
 * The reconciler's verdict, and nothing that resembles a guess.
 *
 * A Magic Action scheduling signature proves an intent was accepted. Within one attempted base
 * transaction the commit and its actions are atomic, but a failing BaseAction can cause the
 * committor to strip every BaseAction from that strategy and retry the remaining commit work,
 * so a later successful commit is not evidence that any action ran. Everything here is an
 * independent reading of base-layer state.
 *
 * This mirrors `crates/vinct-types/src/settlement.rs`. Rust stays authoritative and this file
 * proves it agrees, over all 729 observations of a two-action cohort, in
 * `tests/program/settlement-monitor.test.ts`. Change one and the other fails.
 */

/**
 * What an observer established about one expected effect.
 *
 * The gap between `NotObserved` and `Absent` carries the weight here. `NotObserved` means the
 * account could not be read. `Absent` means it was read and the effect is not there. Collapsing
 * them turns an RPC outage into a false `CommitWithoutActions` and then into a recovery
 * operation nobody needed.
 */
export enum Observation {
  Present = "present",
  Absent = "absent",
  NotObserved = "not_observed",
}

/** Where one expected action sits in its delivery lifecycle. PRD section 11.5. */
export enum ActionDeliveryState {
  Expected = "Expected",
  Scheduled = "Scheduled",
  AttemptObserved = "AttemptObserved",
  Applied = "Applied",
  Reverted = "Reverted",
  RemovedBeforeRetry = "RemovedBeforeRetry",
  Unknown = "Unknown",
}

/** The reconciler's verdict on one operation. PRD section 19.2. */
export enum SettlementClassification {
  AllActionsApplied = "AllActionsApplied",
  CommitWithoutActions = "CommitWithoutActions",
  PartialObservation = "PartialObservation",
  Unknown = "Unknown",
}

/** The incident status a classification justifies. */
export enum SettlementStatus {
  Settled = "Settled",
  CommitWithoutActions = "CommitWithoutActions",
  ReconciliationRequired = "ReconciliationRequired",
  SettlementUnknown = "SettlementUnknown",
}

export interface ActionObservation {
  /** Position in covenant registration order. */
  actionIndex: number;
  /** Whether the adapter wrote its receipt. */
  receipt: Observation;
  /** Whether the target protocol's own state actually changed. */
  targetEffect: Observation;
  deliveryState: ActionDeliveryState;
}

export interface SettlementObservation {
  operationId: Uint8Array;
  /** Whether the scrubbed certificate checkpoint reached base. */
  certificateCheckpoint: Observation;
  /** Whether the final settlement receipt reached base. */
  settlementReceipt: Observation;
  /** One record per expected action, in covenant order. */
  actions: ActionObservation[];
}

/**
 * True when both the receipt and the target effect were seen.
 *
 * A receipt alone is not enough. An adapter could write a receipt and have its CPI fail in a
 * design that swallowed the error, so the target's own state is read independently.
 */
export function isApplied(action: ActionObservation): boolean {
  return action.receipt === Observation.Present && action.targetEffect === Observation.Present;
}

/** True when the observer positively established that nothing happened. */
export function isAbsent(action: ActionObservation): boolean {
  return action.receipt === Observation.Absent && action.targetEffect === Observation.Absent;
}

/** True when any part of this action's outcome could not be read. */
export function isUnknown(action: ActionObservation): boolean {
  return (
    action.receipt === Observation.NotObserved || action.targetEffect === Observation.NotObserved
  );
}

/**
 * Classifies one operation from observations alone.
 *
 * The branches run in order of certainty. `AllActionsApplied` needs positive evidence of every
 * effect. `CommitWithoutActions` needs positive evidence that the checkpoint landed and
 * positive evidence that nothing else did. Anything mixed is `PartialObservation`, anything
 * unreadable is `Unknown`.
 *
 * There is deliberately no branch that reads "most effects applied" as success.
 */
export function classify(observation: SettlementObservation): SettlementClassification {
  if (observation.actions.length === 0) return SettlementClassification.Unknown;

  const anyUnknown =
    observation.certificateCheckpoint === Observation.NotObserved ||
    observation.settlementReceipt === Observation.NotObserved ||
    observation.actions.some(isUnknown);

  const allApplied =
    observation.settlementReceipt === Observation.Present && observation.actions.every(isApplied);
  if (allApplied) return SettlementClassification.AllActionsApplied;

  const noneApplied =
    observation.settlementReceipt === Observation.Absent && observation.actions.every(isAbsent);
  if (noneApplied && observation.certificateCheckpoint === Observation.Present) {
    return SettlementClassification.CommitWithoutActions;
  }

  if (anyUnknown) return SettlementClassification.Unknown;

  const anyApplied =
    observation.settlementReceipt === Observation.Present || observation.actions.some(isApplied);
  if (anyApplied) return SettlementClassification.PartialObservation;

  return SettlementClassification.Unknown;
}

/**
 * Maps a classification onto the status it justifies.
 *
 * `AllActionsApplied` is the only path to `Settled`. Every other classification leaves the
 * incident in a state that says out loud what is and is not known.
 */
export function statusFor(classification: SettlementClassification): SettlementStatus {
  switch (classification) {
    case SettlementClassification.AllActionsApplied:
      return SettlementStatus.Settled;
    case SettlementClassification.CommitWithoutActions:
      return SettlementStatus.CommitWithoutActions;
    case SettlementClassification.PartialObservation:
      return SettlementStatus.ReconciliationRequired;
    case SettlementClassification.Unknown:
      return SettlementStatus.SettlementUnknown;
  }
}

/**
 * True when a classification permits opening a governed recovery proposal.
 *
 * `PartialObservation` deliberately blocks it. A cohort that half-applied means an assumption
 * about transaction-strategy grouping was wrong, and re-running any part of it before someone
 * understands why risks a duplicate effect.
 */
export function permitsRecovery(classification: SettlementClassification): boolean {
  return classification === SettlementClassification.CommitWithoutActions;
}

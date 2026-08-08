/**
 * What the settlement monitor writes down, per PRD section 7.4.4.
 *
 * The ER signature is recorded and then never used to decide anything. It is here because a
 * reconciliation that cannot name the intent it is reconciling is not evidence, and because
 * the gap between "this signature exists" and "these effects exist" is the whole point of the
 * record.
 */

import type { Connection } from "@solana/web3.js";

import {
  classify,
  Observation,
  permitsRecovery,
  SettlementClassification,
  statusFor,
  type SettlementObservation,
  type SettlementStatus,
} from "./classify.js";
import { observeSettlement, type ObserveOptions, type SettlementTargets } from "./observe.js";

export interface SettlementRecord {
  operationId: string;
  /**
   * The ER signature that accepted the intent.
   *
   * Means INTENT_ACCEPTED and nothing more. It is not an input to the classification.
   */
  schedulingSignature: string;
  /** What the cohort was supposed to deliver, named before anything was observed. */
  expectedActions: { actionIndex: number; label: string }[];
  observation: {
    certificateCheckpoint: string;
    settlementReceipt: string;
    actions: {
      actionIndex: number;
      label: string;
      receipt: string;
      targetEffect: string;
      deliveryState: string;
    }[];
  };
  classification: SettlementClassification;
  status: SettlementStatus;
  permitsRecovery: boolean;
  /** Action indices whose absence was positively established, not merely unconfirmed. */
  missingActionIndices: number[];
  observedAt: string;
  /** True when the observation loop gave up before every effect settled. */
  windowElapsed: boolean;
}

export interface ReconcileOptions extends ObserveOptions {
  /** How long to keep re-reading before recording whatever is there. */
  observationWindowMs?: number;
  intervalMs?: number;
  /** Injected so a record is reproducible; the caller stamps it. */
  observedAt?: string;
}

const DEFAULT_WINDOW_MS = 90_000;
const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Polls until every expected effect is applied, or the window closes.
 *
 * A closing window is recorded as `windowElapsed`, and it is not itself a verdict. Whatever the
 * last reading found is what gets classified, so a cohort still in flight comes back
 * `Unknown` or `CommitWithoutActions` on its own evidence rather than because a timer expired.
 */
export async function reconcile(
  connection: Connection,
  targets: SettlementTargets,
  schedulingSignature: string,
  options: ReconcileOptions = {},
): Promise<SettlementRecord> {
  const windowMs = options.observationWindowMs ?? DEFAULT_WINDOW_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + windowMs;

  let observation = await observeSettlement(connection, targets, options);
  let windowElapsed = false;
  while (classify(observation) !== SettlementClassification.AllActionsApplied) {
    if (Date.now() >= deadline) {
      windowElapsed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    observation = await observeSettlement(connection, targets, options);
  }

  return buildRecord(targets, observation, schedulingSignature, windowElapsed, options.observedAt);
}

/** The record for one already-taken observation. Separated so it can be tested without a network. */
export function buildRecord(
  targets: SettlementTargets,
  observation: SettlementObservation,
  schedulingSignature: string,
  windowElapsed: boolean,
  observedAt?: string,
): SettlementRecord {
  const classification = classify(observation);
  const labels = new Map(targets.actions.map((a) => [a.actionIndex, a.label]));

  return {
    operationId: Buffer.from(observation.operationId).toString("hex"),
    schedulingSignature,
    expectedActions: targets.actions.map((a) => ({ actionIndex: a.actionIndex, label: a.label })),
    observation: {
      certificateCheckpoint: observation.certificateCheckpoint,
      settlementReceipt: observation.settlementReceipt,
      actions: observation.actions.map((a) => ({
        actionIndex: a.actionIndex,
        label: labels.get(a.actionIndex) ?? "unnamed",
        receipt: a.receipt,
        targetEffect: a.targetEffect,
        deliveryState: a.deliveryState,
      })),
    },
    classification,
    status: statusFor(classification),
    permitsRecovery: permitsRecovery(classification),
    missingActionIndices: observation.actions
      .filter((a) => a.receipt === Observation.Absent && a.targetEffect === Observation.Absent)
      .map((a) => a.actionIndex),
    observedAt: observedAt ?? new Date().toISOString(),
    windowElapsed,
  };
}

/**
 * Reading base-layer state, and refusing to conclude anything it did not read.
 *
 * The one rule this file exists to enforce: an account that could not be fetched is
 * `NotObserved`, never `Absent`. Every path that touches the network is wrapped so an RPC
 * error, a timeout, or a malformed account yields `NotObserved` and the classification comes
 * back `Unknown`. An observer that reported a network failure as "the effect is not there"
 * would open a recovery proposal for a cohort that settled fine.
 */

import type { Connection, PublicKey } from "@solana/web3.js";

import {
  decodeAdapterReceipt,
  decodeCertificate,
  decodeMarket,
  decodeSettlementReceipt,
} from "../../client/src/index.js";

import {
  ActionDeliveryState,
  Observation,
  type ActionObservation,
  type SettlementObservation,
} from "./classify.js";

/** One action the cohort was supposed to deliver. */
export interface ExpectedAction {
  /** Position in covenant registration order. */
  actionIndex: number;
  /** A label for the record. Never used to decide anything. */
  label: string;
  /** The receipt the adapter writes. */
  adapterReceipt: PublicKey;
  /** The account whose state the action was supposed to change. */
  targetState: PublicKey;
}

/** Everything one operation's reconciliation needs to address. */
export interface SettlementTargets {
  operationId: Uint8Array;
  /** The certificate the scrubbed checkpoint produced. */
  certificate: PublicKey;
  /** The cohort's final settlement receipt. */
  settlementReceipt: PublicKey;
  actions: ExpectedAction[];
}

/**
 * Decides whether a target account shows this operation's intended effect.
 *
 * Protocol-specific by nature: only the target protocol knows what its own state changing
 * looks like. VINCT ships the reader for the mock protocol and a real deployment supplies its
 * own, which keeps the monitor from having to pretend it understands somebody else's account.
 *
 * Returns `Observation`, so a reader that cannot make sense of the account says
 * `NotObserved` rather than guessing.
 */
export type TargetEffectReader = (data: Buffer, operationId: Uint8Array) => Observation;

/**
 * The mock protocol's reader.
 *
 * Requires both the pause and the operation stamp. The pause alone would be satisfied by an
 * earlier operation's pause that never lifted, which is exactly the false positive that makes
 * a replayed cohort look successful.
 */
export const mockProtocolPauseReader: TargetEffectReader = (data, operationId) => {
  let market;
  try {
    market = decodeMarket(data);
  } catch {
    return Observation.NotObserved;
  }
  const stamped = Buffer.from(market.lastOperationId).equals(Buffer.from(operationId));
  return market.newBorrowingPaused && stamped ? Observation.Present : Observation.Absent;
};

/** How long any single account read may take before it counts as unobserved. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

export interface ObserveOptions {
  targetEffectReader?: TargetEffectReader;
  readTimeoutMs?: number;
}

/**
 * Fetches one account, or reports that it could not be fetched.
 *
 * `null` and `undefined` mean different things and both are returned: `{ found: false }` for an
 * account the RPC answered about and said does not exist, and `{ readable: false }` for a read
 * that failed or timed out.
 */
async function readAccount(
  connection: Connection,
  address: PublicKey,
  timeoutMs: number,
): Promise<{ readable: boolean; data: Buffer | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("account read timed out")), timeoutMs);
    });
    const account = await Promise.race([connection.getAccountInfo(address), timeout]);
    return { readable: true, data: account ? account.data : null };
  } catch {
    return { readable: false, data: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Observes whether an account exists and decodes as the operation it should belong to.
 *
 * The operation check is what stops a receipt from another cohort being read as this one's.
 */
async function observeReceipt(
  connection: Connection,
  address: PublicKey,
  timeoutMs: number,
  matches: (data: Buffer) => boolean,
): Promise<Observation> {
  const { readable, data } = await readAccount(connection, address, timeoutMs);
  if (!readable) return Observation.NotObserved;
  if (data === null) return Observation.Absent;
  try {
    return matches(data) ? Observation.Present : Observation.Absent;
  } catch {
    return Observation.NotObserved;
  }
}

/** Reads every expected effect of one operation off the base layer. */
export async function observeSettlement(
  connection: Connection,
  targets: SettlementTargets,
  options: ObserveOptions = {},
): Promise<SettlementObservation> {
  const timeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const readTargetEffect = options.targetEffectReader ?? mockProtocolPauseReader;
  const operationId = Buffer.from(targets.operationId);

  const certificateCheckpoint = await observeReceipt(
    connection,
    targets.certificate,
    timeoutMs,
    (data) => Buffer.from(decodeCertificate(data).operationId).equals(operationId),
  );

  const settlementReceipt = await observeReceipt(
    connection,
    targets.settlementReceipt,
    timeoutMs,
    (data) => {
      const receipt = decodeSettlementReceipt(data);
      return receipt.finalized && Buffer.from(receipt.operationId).equals(operationId);
    },
  );

  const actions: ActionObservation[] = [];
  for (const action of targets.actions) {
    const receipt = await observeReceipt(connection, action.adapterReceipt, timeoutMs, (data) => {
      const decoded = decodeAdapterReceipt(data);
      return decoded.executed && Buffer.from(decoded.operationId).equals(operationId);
    });

    const target = await readAccount(connection, action.targetState, timeoutMs);
    const targetEffect = !target.readable
      ? Observation.NotObserved
      : target.data === null
        ? Observation.Absent
        : readTargetEffect(target.data, targets.operationId);

    actions.push({
      actionIndex: action.actionIndex,
      receipt,
      targetEffect,
      deliveryState: deliveryStateFor(receipt, targetEffect),
    });
  }

  return {
    operationId: targets.operationId,
    certificateCheckpoint,
    settlementReceipt,
    actions,
  };
}

/**
 * The delivery state one action's observations support.
 *
 * Never reaches `Reverted` or `RemovedBeforeRetry`, because neither is visible in account
 * state. Both need the base transaction's own log, which is a separate reading, and inferring
 * either from an absent effect would be exactly the guess this module refuses to make.
 */
function deliveryStateFor(receipt: Observation, targetEffect: Observation): ActionDeliveryState {
  if (receipt === Observation.Present && targetEffect === Observation.Present) {
    return ActionDeliveryState.Applied;
  }
  if (receipt === Observation.NotObserved || targetEffect === Observation.NotObserved) {
    return ActionDeliveryState.Unknown;
  }
  return ActionDeliveryState.Scheduled;
}

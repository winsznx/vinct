/**
 * The crank lifecycle, observed rather than assumed.
 *
 * The validator's own log says it: `Scheduled task request with ID: 4243`, and
 * `Successfully added cancel request for task 4242`. Both are requests. The scheduler applies
 * them asynchronously, so a schedule transaction that succeeded proves an intent was recorded
 * and nothing about whether the task exists, ran, or was removed.
 *
 * This module keeps those apart. `REQUESTED` comes from a transaction. Everything after it
 * comes from reading the rollup and the incident, never from a signature.
 *
 * See docs/decision-log.md D-0059 for what the pinned validator actually does.
 */

import type { Connection, PublicKey } from "@solana/web3.js";

import { IncidentStatus, decodeIncidentCore } from "../../client/src/index.js";

/** PRD section 11.6. A successful schedule or cancel transaction is not a terminal state. */
export enum CrankState {
  /** A schedule transaction succeeded. The scheduler has not been observed doing anything. */
  Requested = "REQUESTED",
  /** The scheduler was observed to have taken the task up. */
  RegistrationObserved = "REGISTRATION_OBSERVED",
  /** At least one iteration was observed executing on the rollup. */
  IterationObserved = "ITERATION_OBSERVED",
  /** The incident reached a terminal status. The reason the task existed is gone. */
  DesiredStateReached = "DESIRED_STATE_REACHED",
  /** A cancel transaction succeeded. The task may still run. */
  CancellationRequested = "CANCELLATION_REQUESTED",
  /** The scheduler was observed to have stopped running it. */
  RemovalObserved = "REMOVAL_OBSERVED",
}

export interface CrankObservation {
  taskId: string;
  state: CrankState;
  /** The schedule request's signature. Evidence of intent, never of execution. */
  requestSignature: string;
  cancelSignature: string | null;
  /** Rollup transactions in which the scheduled instruction was seen to run. */
  iterationSignatures: string[];
  /** The incident's status the last time it was read. */
  incidentStatus: string;
  /**
   * True when the incident is terminal and the task therefore has nothing left to do.
   *
   * Separate from `RemovalObserved`. A task can be pointless and still scheduled, and
   * undelegating its accounts in that window is what breaks every remaining iteration.
   */
  desiredStateReached: boolean;
  /**
   * True when the task ran every iteration it was asked for.
   *
   * A task that stops because it finished is not a task that was removed. Reported separately
   * so a quiet period cannot be mistaken for a cancellation that worked.
   */
  iterationsExhausted: boolean;
  observedAt: string;
  /** Set when the watch window closed before the state stopped moving. */
  windowElapsed: boolean;
}

/**
 * The scheduler's executor program.
 *
 * Every iteration appears as a transaction in which `Crank11111111111111111111111111111111111111`
 * invokes the target program. That inner invocation is the only durable evidence that an
 * iteration happened, so it is what gets counted.
 */
export const CRANK_PROGRAM_ID = "Crank11111111111111111111111111111111111111";

/** The log line the executor emits after running a task's instructions. */
const EXECUTED_MARKER = "Executed crank with";

export interface WatchOptions {
  /** How long to keep looking before recording whatever was reached. */
  watchWindowMs?: number;
  intervalMs?: number;
  /** Injected so a record is reproducible. */
  observedAt?: string;
  /** Only transactions after this signature count. Excludes anything from an earlier run. */
  since?: string | null;
}

const DEFAULT_WATCH_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Counts iterations of this program's scheduled work on the rollup.
 *
 * A transaction counts only when the crank executor is among its accounts and its logs carry
 * the executor's completion marker. Matching on the target program alone would count ordinary
 * user transactions, which is how a state machine ends up reporting an iteration that a person
 * performed by hand.
 */
export async function countIterations(
  er: Connection,
  program: PublicKey,
  since: string | null,
): Promise<string[]> {
  const signatures = await er.getSignaturesForAddress(program, { limit: 100 });
  const stopAt = since ? signatures.findIndex((entry) => entry.signature === since) : -1;
  const candidates = (stopAt >= 0 ? signatures.slice(0, stopAt) : signatures).map(
    (entry) => entry.signature,
  );

  const iterations: string[] = [];
  for (const signature of candidates) {
    const parsed = await er.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed) continue;
    const logs = parsed.meta?.logMessages ?? [];
    const executed = logs.some((line) => line.includes(EXECUTED_MARKER));
    const keys = parsed.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((key) => key.toBase58());
    if (executed && keys.includes(CRANK_PROGRAM_ID)) iterations.push(signature);
  }
  return iterations.reverse();
}

/**
 * Every crank-executed transaction since a marker, with whether it succeeded.
 *
 * `countIterations` answers "did it run". This answers "what happened when it did", which is
 * the question that matters once the accounts a task touches have left the rollup. A task
 * outliving its accounts is the predictable failure the crank reference warns about, and the
 * only way to know whether VINCT's version of it is harmless is to read the outcomes.
 */
export async function iterationOutcomes(
  er: Connection,
  program: PublicKey,
  since: string | null,
): Promise<{ signature: string; succeeded: boolean; error: string | null }[]> {
  const signatures = await er.getSignaturesForAddress(program, { limit: 100 });
  const stopAt = since ? signatures.findIndex((entry) => entry.signature === since) : -1;
  const candidates = stopAt >= 0 ? signatures.slice(0, stopAt) : signatures;

  const outcomes: { signature: string; succeeded: boolean; error: string | null }[] = [];
  for (const entry of candidates) {
    const parsed = await er.getTransaction(entry.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed) continue;
    const keys = parsed.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((key) => key.toBase58());
    if (!keys.includes(CRANK_PROGRAM_ID)) continue;
    outcomes.push({
      signature: entry.signature,
      succeeded: parsed.meta?.err === null,
      error: parsed.meta?.err ? JSON.stringify(parsed.meta.err) : null,
    });
  }
  return outcomes.reverse();
}

/**
 * Watches a requested task until it stops moving, or the window closes.
 *
 * `RegistrationObserved` is reported from the first observed iteration rather than from a
 * registry lookup, because this validator exposes no way to ask whether a task is registered.
 * That is an honest weakening and it is recorded as one: registration is inferred from
 * execution, so a task that is registered and has not yet fired reads as `REQUESTED`. The
 * state machine never reports the reverse, which is the direction that would matter.
 */
export async function watchExpiryCrank(
  er: Connection,
  options: {
    taskId: bigint;
    program: PublicKey;
    incidentCore: PublicKey;
    requestSignature: string;
  } & WatchOptions,
): Promise<CrankObservation> {
  const watchMs = options.watchWindowMs ?? DEFAULT_WATCH_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + watchMs;

  let iterations: string[] = [];
  let terminal = false;
  let status = "unread";
  let windowElapsed = true;

  for (;;) {
    iterations = await countIterations(er, options.program, options.since ?? null);
    const account = await er.getAccountInfo(options.incidentCore);
    if (account) {
      const core = decodeIncidentCore(account.data);
      status = IncidentStatus[core.status] ?? String(core.status);
      terminal = core.status !== IncidentStatus.Draft && core.status !== IncidentStatus.Collecting;
    }
    if (terminal && iterations.length > 0) {
      windowElapsed = false;
      break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    taskId: options.taskId.toString(),
    state: crankStateFor({
      iterations: iterations.length,
      desiredStateReached: terminal,
      cancelled: false,
      removalObserved: false,
    }),
    requestSignature: options.requestSignature,
    cancelSignature: null,
    iterationSignatures: iterations,
    incidentStatus: status,
    desiredStateReached: terminal,
    iterationsExhausted: false,
    observedAt: options.observedAt ?? new Date().toISOString(),
    windowElapsed,
  };
}

/**
 * Watches for a cancelled task to stop running.
 *
 * Removal is established by absence over time, which is the only evidence available: the
 * validator has no queryable task registry. So the check is that the iteration count held
 * still across a full quiet window, and the window is a parameter rather than a constant
 * because how long is long enough is a property of the interval, not of this code.
 *
 * A task that ran out of iterations also stops. That is not removal, and an earlier version of
 * this function called it one: a cancel request was accepted, the task ran all 32 of its
 * requested iterations, the count then held still because there was nothing left to run, and
 * the state machine reported `REMOVAL_OBSERVED` for a cancellation that did nothing.
 * `requestedIterations` is what separates the two, and when the count reaches it the quiet
 * period proves nothing about the cancel.
 */
export async function watchCancellation(
  er: Connection,
  options: {
    taskId: bigint;
    program: PublicKey;
    incidentCore: PublicKey;
    requestSignature: string;
    cancelSignature: string;
    /** How long the iteration count must hold still. Make it a few intervals. */
    quietWindowMs: number;
    /**
     * How many iterations the task was asked for.
     *
     * A count that reaches this is exhaustion, and a quiet period afterwards says nothing
     * about whether the cancel was applied.
     */
    requestedIterations: number;
  } & WatchOptions,
): Promise<CrankObservation> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + (options.watchWindowMs ?? DEFAULT_WATCH_MS);

  let iterations = await countIterations(er, options.program, options.since ?? null);
  let quietSince = Date.now();
  let removalObserved = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const seen = await countIterations(er, options.program, options.since ?? null);
    if (seen.length !== iterations.length) {
      iterations = seen;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= options.quietWindowMs) {
      // Quiet because it was removed, or quiet because it is finished. Only the first is
      // evidence about the cancel.
      removalObserved = iterations.length < options.requestedIterations;
      break;
    }
  }

  const account = await er.getAccountInfo(options.incidentCore);
  const core = account ? decodeIncidentCore(account.data) : null;
  const terminal = core
    ? core.status !== IncidentStatus.Draft && core.status !== IncidentStatus.Collecting
    : false;
  const exhausted = iterations.length >= options.requestedIterations;

  return {
    taskId: options.taskId.toString(),
    iterationsExhausted: exhausted,
    // Exhaustion outranks the terminal status here. An incident that went terminal because the
    // task ran to completion did not have its task removed, and reporting
    // `DESIRED_STATE_REACHED` would hide that the cancel was never applied.
    state: exhausted
      ? CrankState.IterationObserved
      : crankStateFor({
          iterations: iterations.length,
          desiredStateReached: terminal,
          cancelled: true,
          removalObserved,
        }),
    requestSignature: options.requestSignature,
    cancelSignature: options.cancelSignature,
    iterationSignatures: iterations,
    incidentStatus: core ? (IncidentStatus[core.status] ?? String(core.status)) : "unread",
    desiredStateReached: terminal,
    observedAt: options.observedAt ?? new Date().toISOString(),
    windowElapsed: !removalObserved,
  };
}

/**
 * The state a set of observations supports.
 *
 * Ordered by how much has been established, most first. A cancelled task whose removal was
 * observed is further along than one whose iterations were seen, and an incident that reached
 * its terminal status outranks both because at that point the task's purpose is served
 * whatever the scheduler does next.
 */
export function crankStateFor(observed: {
  iterations: number;
  desiredStateReached: boolean;
  cancelled: boolean;
  removalObserved: boolean;
}): CrankState {
  if (observed.removalObserved) return CrankState.RemovalObserved;
  if (observed.desiredStateReached) return CrankState.DesiredStateReached;
  if (observed.cancelled) return CrankState.CancellationRequested;
  if (observed.iterations > 0) return CrankState.IterationObserved;
  return CrankState.Requested;
}

/**
 * Whether the incident's accounts may be taken off the rollup.
 *
 * The one question this module exists to answer. Undelegating while a task is still scheduled
 * leaves every remaining iteration hitting accounts that are no longer there, so the safe
 * answer is the conservative one: either removal was observed, or the incident is terminal and
 * the handler will no-op for whatever iterations remain.
 */
export function safeToUndelegate(observation: CrankObservation): boolean {
  return (
    observation.state === CrankState.RemovalObserved ||
    observation.state === CrankState.DesiredStateReached
  );
}

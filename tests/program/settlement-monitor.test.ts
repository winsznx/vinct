/**
 * The TypeScript monitor against the Rust classifier, on every input rather than a sample.
 *
 * The monitor is what decides whether an incident reached `SETTLED`, and whether a governed
 * recovery may be opened. Both decisions are made by a hand-written mirror of
 * `crates/vinct-types/src/settlement.rs`, which is exactly the arrangement that produced the
 * decoder drift in D-0051. So the mirror is checked against the original on all 729
 * observations of a two-action cohort, not on the handful a person would have thought to write.
 *
 * Regenerate the vectors with `pnpm gen-vectors` after any change to the Rust classifier.
 *
 *   pnpm exec tsx --test tests/program/settlement-monitor.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Connection, PublicKey } from "@solana/web3.js";

import {
  ActionDeliveryState,
  buildRecord,
  classify,
  observeSettlement,
  Observation,
  permitsRecovery,
  proposeRecovery,
  RecoveryRefusal,
  RecoveryRefused,
  recoveryOperationId,
  SettlementClassification,
  statusFor,
  type ActionObservation,
  type SettlementObservation,
  type SettlementTargets,
} from "../../packages/monitor/src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface VectorCase {
  certificate_checkpoint: string;
  settlement_receipt: string;
  actions: { action_index: number; receipt: string; target_effect: string }[];
  classification: string;
  status: string;
  permits_recovery: boolean;
}

const VECTORS = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages", "test-vectors", "canonical-vectors.json"), "utf8"),
) as {
  settlement_classification: {
    operation_id: string;
    case_count: number;
    cases: VectorCase[];
    empty_cohort: VectorCase;
  };
  recovery_operation_id: {
    inputs: {
      original_operation_id: string;
      covenant: string;
      circle_epoch: string;
      incident_id: string;
      recovery_nonce: string;
    };
    sha256: string;
    differs_from_original: boolean;
  };
};

const SETTLEMENT = VECTORS.settlement_classification;
const OPERATION_ID = Buffer.from(SETTLEMENT.operation_id, "hex");

function observation(value: string): Observation {
  switch (value) {
    case "present":
      return Observation.Present;
    case "absent":
      return Observation.Absent;
    case "not_observed":
      return Observation.NotObserved;
    default:
      throw new Error(`the vectors carry an observation this build does not know: ${value}`);
  }
}

function asObservation(vector: VectorCase): SettlementObservation {
  return {
    operationId: OPERATION_ID,
    certificateCheckpoint: observation(vector.certificate_checkpoint),
    settlementReceipt: observation(vector.settlement_receipt),
    actions: vector.actions.map((action): ActionObservation => ({
      actionIndex: action.action_index,
      receipt: observation(action.receipt),
      targetEffect: observation(action.target_effect),
      deliveryState: ActionDeliveryState.Scheduled,
    })),
  };
}

test("the monitor classifies every observation the way the Rust classifier does", () => {
  assert.equal(SETTLEMENT.case_count, 729, "the vectors are no longer exhaustive");
  assert.equal(SETTLEMENT.cases.length, SETTLEMENT.case_count);

  for (const vector of SETTLEMENT.cases) {
    const observed = asObservation(vector);
    const label = JSON.stringify({
      checkpoint: vector.certificate_checkpoint,
      settlement: vector.settlement_receipt,
      actions: vector.actions.map((a) => [a.receipt, a.target_effect]),
    });
    assert.equal(classify(observed), vector.classification, `classification disagrees on ${label}`);
    assert.equal(statusFor(classify(observed)), vector.status, `status disagrees on ${label}`);
    assert.equal(
      permitsRecovery(classify(observed)),
      vector.permits_recovery,
      `recovery eligibility disagrees on ${label}`,
    );
  }
});

/**
 * Every classification is actually reached.
 *
 * A sweep that never produces `AllActionsApplied` is a sweep whose inputs were accidentally
 * constrained, and it would still pass the parity test above while proving much less.
 */
test("the sweep reaches all four classifications", () => {
  const reached = new Set(SETTLEMENT.cases.map((c) => c.classification));
  for (const expected of Object.values(SettlementClassification)) {
    assert.ok(reached.has(expected), `no case in the sweep produces ${expected}`);
  }
});

test("an empty cohort is Unknown, never success", () => {
  const empty: SettlementObservation = {
    operationId: OPERATION_ID,
    certificateCheckpoint: Observation.Present,
    settlementReceipt: Observation.Present,
    actions: [],
  };
  assert.equal(classify(empty), SETTLEMENT.empty_cohort.classification);
  assert.equal(classify(empty), SettlementClassification.Unknown);
});

/**
 * An unreadable account never becomes an absent effect.
 *
 * This is the difference between an RPC outage and a cohort that did not deliver. Reported as
 * absent, an outage opens a recovery proposal for an operation that settled fine.
 */
test("a read failure classifies as Unknown, never CommitWithoutActions", () => {
  const outage: SettlementObservation = {
    operationId: OPERATION_ID,
    certificateCheckpoint: Observation.Present,
    settlementReceipt: Observation.NotObserved,
    actions: [
      {
        actionIndex: 0,
        receipt: Observation.NotObserved,
        targetEffect: Observation.NotObserved,
        deliveryState: ActionDeliveryState.Unknown,
      },
    ],
  };
  assert.equal(classify(outage), SettlementClassification.Unknown);
  assert.equal(permitsRecovery(classify(outage)), false);
});

/** A receipt with no target effect is not settlement. */
test("a receipt without its target effect is not applied", () => {
  const receiptOnly: SettlementObservation = {
    operationId: OPERATION_ID,
    certificateCheckpoint: Observation.Present,
    settlementReceipt: Observation.Present,
    actions: [
      {
        actionIndex: 0,
        receipt: Observation.Present,
        targetEffect: Observation.Absent,
        deliveryState: ActionDeliveryState.Scheduled,
      },
    ],
  };
  assert.equal(classify(receiptOnly), SettlementClassification.PartialObservation);
  assert.notEqual(classify(receiptOnly), SettlementClassification.AllActionsApplied);
});

/**
 * A service that hangs is `NotObserved`, not `Absent`.
 *
 * The stub accepts the connection and never answers, which is what an overloaded RPC looks
 * like from the client's side and is worse than an outright refusal: the socket stays open and
 * an observer without a timeout waits forever. This runs the real `observeSettlement` against
 * a real `Connection`, so what is under test is the network path, not a hand-made observation.
 */
test("an RPC that hangs yields NotObserved and never fabricates an absence", async () => {
  const hung = createServer(() => {
    // Deliberately no response. The socket stays open until the test tears it down.
  });
  // Sockets are tracked so teardown can destroy them. `close` alone waits for every open
  // connection, and every connection here is one that will never finish.
  const sockets = new Set<import("node:net").Socket>();
  hung.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const port = (hung.address() as AddressInfo).port;

  try {
    const connection = new Connection(`http://127.0.0.1:${port}`, "confirmed");
    const observed = await observeSettlement(connection, targets(2), { readTimeoutMs: 250 });

    assert.equal(observed.certificateCheckpoint, Observation.NotObserved);
    assert.equal(observed.settlementReceipt, Observation.NotObserved);
    for (const action of observed.actions) {
      assert.equal(action.receipt, Observation.NotObserved);
      assert.equal(action.targetEffect, Observation.NotObserved);
      assert.equal(action.deliveryState, ActionDeliveryState.Unknown);
    }

    const classification = classify(observed);
    assert.equal(classification, SettlementClassification.Unknown);
    assert.notEqual(
      classification,
      SettlementClassification.CommitWithoutActions,
      "a hung service was read as a cohort that did not deliver",
    );
    assert.equal(permitsRecovery(classification), false);

    const record = buildRecord(targets(2), observed, "SIG", true, "1970-01-01T00:00Z");
    assert.deepEqual(
      record.missingActionIndices,
      [],
      "an unreadable action was reported as positively missing",
    );
    assert.ok(record.windowElapsed);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => hung.close(resolve));
  }
});

// ------------------------------------------------------------------- recovery

function targets(count: number): SettlementTargets {
  return {
    operationId: OPERATION_ID,
    certificate: PublicKey.default,
    settlementReceipt: PublicKey.default,
    actions: Array.from({ length: count }, (_, index) => ({
      actionIndex: index,
      label: `adapter-${index}`,
      adapterReceipt: PublicKey.default,
      targetState: PublicKey.default,
    })),
  };
}

function recordFor(classification: SettlementClassification) {
  const absent = {
    receipt: Observation.Absent,
    targetEffect: Observation.Absent,
    deliveryState: ActionDeliveryState.Scheduled,
  };
  const present = {
    receipt: Observation.Present,
    targetEffect: Observation.Present,
    deliveryState: ActionDeliveryState.Applied,
  };
  const shapes: Record<SettlementClassification, SettlementObservation> = {
    [SettlementClassification.CommitWithoutActions]: {
      operationId: OPERATION_ID,
      certificateCheckpoint: Observation.Present,
      settlementReceipt: Observation.Absent,
      actions: [
        { actionIndex: 0, ...absent },
        { actionIndex: 1, ...absent },
      ],
    },
    [SettlementClassification.AllActionsApplied]: {
      operationId: OPERATION_ID,
      certificateCheckpoint: Observation.Present,
      settlementReceipt: Observation.Present,
      actions: [
        { actionIndex: 0, ...present },
        { actionIndex: 1, ...present },
      ],
    },
    [SettlementClassification.PartialObservation]: {
      operationId: OPERATION_ID,
      certificateCheckpoint: Observation.Present,
      settlementReceipt: Observation.Absent,
      actions: [
        { actionIndex: 0, ...present },
        { actionIndex: 1, ...absent },
      ],
    },
    [SettlementClassification.Unknown]: {
      operationId: OPERATION_ID,
      certificateCheckpoint: Observation.NotObserved,
      settlementReceipt: Observation.NotObserved,
      actions: [
        {
          actionIndex: 0,
          receipt: Observation.NotObserved,
          targetEffect: Observation.NotObserved,
          deliveryState: ActionDeliveryState.Unknown,
        },
        { actionIndex: 1, ...absent },
      ],
    },
  };
  const shape = shapes[classification];
  const record = buildRecord(targets(2), shape, "SCHEDULING_SIGNATURE", false, "1970-01-01T00:00Z");
  assert.equal(record.classification, classification, "the fixture does not classify as intended");
  return record;
}

const RECOVERY_INPUTS = {
  originalOperationId: OPERATION_ID,
  originalCertificateHash: Buffer.alloc(32, 7),
  covenant: Buffer.alloc(32, 3),
  circleEpoch: 1n,
  incidentId: 7n,
  recoveryNonce: 99n,
  originalCertificateNonce: 42n,
  expiresAtSlot: 5_000n,
  requiredApprovals: 2,
};

test("the recovery operation ID matches the Rust derivation", () => {
  const vector = VECTORS.recovery_operation_id;
  const derived = recoveryOperationId(
    Buffer.from(vector.inputs.original_operation_id, "hex"),
    Buffer.from(vector.inputs.covenant, "hex"),
    BigInt(vector.inputs.circle_epoch),
    BigInt(vector.inputs.incident_id),
    BigInt(vector.inputs.recovery_nonce),
  );
  assert.equal(Buffer.from(derived).toString("hex"), vector.sha256);
  assert.ok(vector.differs_from_original, "a recovery reused the original operation's identity");
});

test("a commit without actions proposes a recovery under a new operation ID", () => {
  const record = recordFor(SettlementClassification.CommitWithoutActions);
  const proposal = proposeRecovery(record, RECOVERY_INPUTS, [], 100n);

  assert.deepEqual(proposal.missingActionIndices, [0, 1]);
  assert.equal(proposal.approvalCount, 0);
  assert.equal(proposal.requiredApprovals, 2);
  assert.notEqual(
    proposal.recoveryOperationId,
    Buffer.from(OPERATION_ID).toString("hex"),
    "the recovery reused the original operation ID",
  );
});

test("a partial observation blocks recovery outright", () => {
  const record = recordFor(SettlementClassification.PartialObservation);
  assert.throws(
    () => proposeRecovery(record, RECOVERY_INPUTS, [], 100n),
    (error: unknown) =>
      error instanceof RecoveryRefused &&
      error.refusal === RecoveryRefusal.ClassificationBlocksRecovery,
    "a half-applied cohort was allowed to open an automated recovery",
  );
});

test("an unclassifiable observation blocks recovery", () => {
  const record = recordFor(SettlementClassification.Unknown);
  assert.throws(
    () => proposeRecovery(record, RECOVERY_INPUTS, [], 100n),
    (error: unknown) =>
      error instanceof RecoveryRefused &&
      error.refusal === RecoveryRefusal.ClassificationBlocksRecovery,
  );
});

test("a settled operation has nothing to recover", () => {
  const record = recordFor(SettlementClassification.AllActionsApplied);
  assert.throws(
    () => proposeRecovery(record, RECOVERY_INPUTS, [], 100n),
    (error: unknown) => error instanceof RecoveryRefused,
  );
});

test("a recovery refuses to reuse the original certificate nonce", () => {
  const record = recordFor(SettlementClassification.CommitWithoutActions);
  assert.throws(
    () => proposeRecovery(record, { ...RECOVERY_INPUTS, recoveryNonce: 42n }, [], 100n),
    (error: unknown) =>
      error instanceof RecoveryRefused && error.refusal === RecoveryRefusal.ReusedCertificateNonce,
  );
});

test("one operation gets one recovery", () => {
  const record = recordFor(SettlementClassification.CommitWithoutActions);
  const first = proposeRecovery(record, RECOVERY_INPUTS, [], 100n);
  assert.throws(
    () => proposeRecovery(record, { ...RECOVERY_INPUTS, recoveryNonce: 100n }, [first], 100n),
    (error: unknown) =>
      error instanceof RecoveryRefused && error.refusal === RecoveryRefusal.DuplicateRecovery,
  );
});

test("a recovery cannot be proposed after its own window closes", () => {
  const record = recordFor(SettlementClassification.CommitWithoutActions);
  assert.throws(
    () => proposeRecovery(record, RECOVERY_INPUTS, [], 5_000n),
    (error: unknown) =>
      error instanceof RecoveryRefused && error.refusal === RecoveryRefusal.Expired,
  );
});

test("a recovery cannot be built from another operation's record", () => {
  const record = recordFor(SettlementClassification.CommitWithoutActions);
  assert.throws(
    () =>
      proposeRecovery(
        record,
        { ...RECOVERY_INPUTS, originalOperationId: Buffer.alloc(32, 9) },
        [],
        100n,
      ),
    (error: unknown) =>
      error instanceof RecoveryRefused &&
      error.refusal === RecoveryRefusal.MissingEffectNotInOriginal,
  );
});

/**
 * The record names the intent it reconciles and then ignores it.
 *
 * A scheduling signature in the record is evidence of what was asked for. It must not be
 * evidence of what happened, and the way to check that is to change it and see nothing move.
 */
test("the scheduling signature does not influence the classification", () => {
  const shape = recordFor(SettlementClassification.CommitWithoutActions);
  const other = buildRecord(
    targets(2),
    {
      operationId: OPERATION_ID,
      certificateCheckpoint: Observation.Present,
      settlementReceipt: Observation.Absent,
      actions: [
        {
          actionIndex: 0,
          receipt: Observation.Absent,
          targetEffect: Observation.Absent,
          deliveryState: ActionDeliveryState.Scheduled,
        },
        {
          actionIndex: 1,
          receipt: Observation.Absent,
          targetEffect: Observation.Absent,
          deliveryState: ActionDeliveryState.Scheduled,
        },
      ],
    },
    "A_COMPLETELY_DIFFERENT_SIGNATURE",
    false,
    "1970-01-01T00:00Z",
  );
  assert.equal(other.classification, shape.classification);
  assert.notEqual(other.schedulingSignature, shape.schedulingSignature);
});

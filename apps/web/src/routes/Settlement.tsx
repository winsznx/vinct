/**
 * What landed, what did not, and the difference between not knowing and knowing it did not.
 *
 * The classification comes from `packages/monitor`, the same module the local-stack runs use,
 * which is checked against the Rust classifier on every observation of a two-action cohort. The
 * page owns none of that logic. A page that classified its own reads could be made to show a
 * settlement by editing the page.
 */

import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import { PublicKey } from "@solana/web3.js";
import { certificateAddress, decodeCertificate, settlementReceiptAddress } from "@vinct/client";
import {
  Observation,
  SettlementClassification,
  buildRecord,
  classify,
  permitsRecovery,
  recoveryVerdict,
  statusFor,
  type SettlementObservation,
} from "@vinct/monitor";

import {
  Address,
  Card,
  Empty,
  Eyebrow,
  Field,
  Fields,
  Problem,
  Rule,
  Section,
  Stamp,
  State,
  type Tone,
} from "../components/ui";
import { connect, findCapabilities, findIncidents, hex, shortAddress } from "../data/chain";
import { readEndpoints, recallCovenant } from "../data/config";
import { usePolled } from "../data/useChain";

export function Settlement() {
  const location = useLocation();
  const endpoints = readEndpoints(location.search);
  const params = new URLSearchParams(location.search);
  const covenantParam = params.get("covenant") ?? recallCovenant();

  const covenant = useMemo(() => {
    if (!covenantParam) return null;
    try {
      return new PublicKey(covenantParam);
    } catch {
      return null;
    }
  }, [covenantParam]);

  const { state } = usePolled(
    async () => {
      if (!covenant) return null;
      const connection = connect(endpoints.base);
      const incidents = await findIncidents(connection, covenant);
      const settled = incidents.filter((incident) => !/^0+$/.test(hex(incident.core.operationId)));
      const target = settled[settled.length - 1];
      if (!target) return null;

      const operationId = target.core.operationId;
      const capabilities = await findCapabilities(connection, covenant);

      // Every reading is separate, and a read that fails is NotObserved rather than absent. The
      // distinction is the module's reason to exist: an RPC outage reported as an absence opens
      // a recovery proposal for an operation that settled fine.
      const certificateAccount = await connection.getAccountInfo(certificateAddress(operationId));
      const settlementAccount = await connection.getAccountInfo(
        settlementReceiptAddress(operationId),
      );
      const { decodeAdapterReceipt, decodeMarket, adapterReceiptAddress } =
        await import("@vinct/client");

      const actions = [];
      for (const [index, entry] of capabilities.entries()) {
        const receiptAccount = await connection.getAccountInfo(
          adapterReceiptAddress(operationId, entry.address),
        );
        const receipt = receiptAccount ? decodeAdapterReceipt(receiptAccount.data) : null;

        const marketAccount = await connection.getAccountInfo(entry.capability.protocolState);
        let targetEffect = Observation.Absent;
        if (marketAccount) {
          try {
            const market = decodeMarket(marketAccount.data);
            const stamped = hex(market.lastOperationId) === hex(operationId);
            targetEffect =
              market.newBorrowingPaused && stamped ? Observation.Present : Observation.Absent;
          } catch {
            targetEffect = Observation.NotObserved;
          }
        }

        actions.push({
          actionIndex: index,
          label: shortAddress(entry.capability.protocolAuthority),
          receipt:
            receipt && receipt.executed && hex(receipt.operationId) === hex(operationId)
              ? Observation.Present
              : Observation.Absent,
          targetEffect,
        });
      }

      const observation: SettlementObservation = {
        operationId,
        certificateCheckpoint:
          certificateAccount &&
          hex(decodeCertificate(certificateAccount.data).operationId) === hex(operationId)
            ? Observation.Present
            : Observation.Absent,
        settlementReceipt: settlementAccount ? Observation.Present : Observation.Absent,
        actions: actions.map((action) => ({
          actionIndex: action.actionIndex,
          receipt: action.receipt,
          targetEffect: action.targetEffect,
          deliveryState:
            action.receipt === Observation.Present && action.targetEffect === Observation.Present
              ? ("Applied" as never)
              : ("Scheduled" as never),
        })),
      };

      const record = buildRecord(
        {
          operationId,
          certificate: certificateAddress(operationId),
          settlementReceipt: settlementReceiptAddress(operationId),
          actions: actions.map((action) => ({
            actionIndex: action.actionIndex,
            label: action.label,
            adapterReceipt: adapterReceiptAddress(
              operationId,
              capabilities[action.actionIndex]!.address,
            ),
            targetState: capabilities[action.actionIndex]!.capability.protocolState,
          })),
        },
        observation,
        "read from base, not from a scheduling signature",
        false,
      );

      return { incident: target, record, observation };
    },
    [endpoints.base, covenant?.toBase58()],
    6_000,
  );

  return (
    <>
      <Eyebrow>Read from base-layer accounts. Never from a scheduling signature.</Eyebrow>
      <Stamp>SETTLEMENT</Stamp>
      <p style={{ maxWidth: 720, marginTop: "var(--spacing-24)" }}>
        A Magic Action scheduling signature means an intent was accepted. Within one attempted base
        transaction the commit and its actions are atomic, but a failing action can cause the
        committor to strip every action from that transaction and retry the commit alone. So a later
        successful commit is not evidence that anything ran.
      </p>

      {!covenant && (
        <div style={{ marginTop: "var(--spacing-48)" }}>
          <Empty>No covenant selected. Open Formation to point this page at one.</Empty>
        </div>
      )}

      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}

      {covenant && state.status === "ready" && !state.value && (
        <Empty>No incident under this covenant has certified, so there is nothing to settle.</Empty>
      )}

      {state.status === "ready" && state.value && (
        <>
          <Section title="CLASSIFICATION">
            <Card outlined>
              <State tone={classificationTone(state.value.record.classification)}>
                {state.value.record.classification.toUpperCase()}
              </State>
              <p style={{ maxWidth: 640, marginTop: "var(--spacing-16)" }}>
                {explain(state.value.record.classification)}
              </p>
              <div style={{ margin: "var(--spacing-24) 0" }}>
                <Rule />
              </div>
              <Fields>
                <Field label="Incident status">
                  {statusFor(state.value.record.classification)}
                </Field>
                <Field label="Operation" mono>
                  {state.value.record.operationId.slice(0, 24)}…
                </Field>
                <Field label="Recovery">
                  {permitsRecovery(state.value.record.classification)
                    ? "permitted, under a new operation ID"
                    : "blocked"}
                </Field>
              </Fields>
            </Card>
            <Empty>{recoveryVerdict(state.value.record)}</Empty>
          </Section>

          <Section title="EVERY EXPECTED EFFECT">
            <div style={{ display: "grid" }} data-testid="effect-list">
              <EffectRow
                name="Certificate checkpoint"
                observation={state.value.observation.certificateCheckpoint}
              />
              {state.value.observation.actions.map((action, index) => (
                <EffectRow
                  key={action.actionIndex}
                  name={`${state.value!.record.expectedActions[index]?.label ?? "adapter"} — receipt`}
                  observation={action.receipt}
                  second={{ name: "target effect", observation: action.targetEffect }}
                />
              ))}
              <EffectRow
                name="Settlement receipt"
                observation={state.value.observation.settlementReceipt}
              />
              <Rule />
            </div>
            <Empty>
              Three values, not two. Present means it was read and it is there. Absent means it was
              read and it is not. Not observed means the account could not be read at all, and
              collapsing that into absent turns an RPC outage into a recovery nobody needed.
            </Empty>
          </Section>
        </>
      )}
    </>
  );
}

function EffectRow({
  name,
  observation,
  second,
}: {
  name: string;
  observation: Observation;
  second?: { name: string; observation: Observation };
}) {
  return (
    <div>
      <Rule />
      <div
        style={{
          display: "flex",
          gap: "var(--spacing-24)",
          padding: "var(--spacing-20) 0",
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        <span style={{ flex: "1 1 260px" }}>{name}</span>
        <State tone={observationTone(observation)}>
          {observation.replace("_", " ").toUpperCase()}
        </State>
        {second && (
          <>
            <span style={{ color: "var(--color-steel)" }}>{second.name}</span>
            <State tone={observationTone(second.observation)}>
              {second.observation.replace("_", " ").toUpperCase()}
            </State>
          </>
        )}
      </div>
    </div>
  );
}

function observationTone(observation: Observation): Tone {
  if (observation === Observation.Present) return "good";
  if (observation === Observation.Absent) return "waiting";
  return "blocked";
}

function classificationTone(classification: SettlementClassification): Tone {
  switch (classification) {
    case SettlementClassification.AllActionsApplied:
      return "good";
    case SettlementClassification.CommitWithoutActions:
      return "attention";
    case SettlementClassification.PartialObservation:
      return "blocked";
    default:
      return "waiting";
  }
}

function explain(classification: SettlementClassification): string {
  switch (classification) {
    case SettlementClassification.AllActionsApplied:
      return "Every adapter receipt, every target effect, and the settlement receipt were observed on base. This is the only path to settled.";
    case SettlementClassification.CommitWithoutActions:
      return "The scrubbed checkpoint reached base and nothing else did. A governed recovery may be opened, under a new operation ID, never as a retry of the actions that appear to be missing.";
    case SettlementClassification.PartialObservation:
      return "Some effects exist and the cohort is incomplete. This is a critical invariant failure: one intended cohort should share one transaction outcome, so an assumption about transaction grouping was wrong. Automated recovery is blocked until somebody understands why.";
    default:
      return "The evidence is insufficient to classify. Something could not be read, and nothing is inferred from that.";
  }
}

export { Address };

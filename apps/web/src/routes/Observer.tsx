/**
 * The public view of an incident, and everything it deliberately cannot show.
 *
 * An observer sees that an incident is open, when it closes, and what it settled to. They do
 * not see how many approvals have arrived, because no account holds that number while an
 * incident is live and the page has nothing to read even if it wanted to.
 *
 * The absence is stated rather than left as a gap. A page that simply omitted the tally would
 * look like one that had not loaded it.
 */

import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";

import { PublicKey } from "@solana/web3.js";
import { IncidentStatus } from "@vinct/client";

import {
  Address,
  Button,
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
} from "../components/ui";
import {
  connect,
  findIncidents,
  hex,
  isTerminal,
  shortAddress,
  type IncidentView,
} from "../data/chain";
import { readEndpoints, recallCovenant } from "../data/config";
import { usePolled } from "../data/useChain";

export function Observer() {
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

  const { state, refresh } = usePolled(
    async () => (covenant ? findIncidents(connect(endpoints.base), covenant) : []),
    [endpoints.base, covenant?.toBase58()],
  );

  return (
    <>
      <Eyebrow>Public. No wallet, no membership, no permission.</Eyebrow>
      <Stamp>OBSERVER</Stamp>
      <p style={{ maxWidth: 720, marginTop: "var(--spacing-24)" }}>
        Everything a covenant lets the world see about an incident. Which is: that it exists, when
        it closes, and what it settled to.
      </p>

      {!covenant && (
        <div style={{ marginTop: "var(--spacing-48)" }}>
          <Empty>
            No covenant selected. Open Formation to point this page at one, or add{" "}
            <span className="mono">?covenant=&lt;address&gt;</span> to the URL.
          </Empty>
        </div>
      )}

      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}
      {state.status === "unsupported" && <Problem kind="unsupported" message={state.message} />}

      {covenant && state.status === "ready" && (
        <Section title="INCIDENTS">
          {state.value.length === 0 ? (
            <Empty>This covenant has opened no incidents.</Empty>
          ) : (
            <div style={{ display: "grid", gap: "var(--spacing-24)" }} data-testid="incident-list">
              {state.value.map((incident) => (
                <IncidentRow
                  key={incident.address.toBase58()}
                  incident={incident}
                  search={location.search}
                />
              ))}
            </div>
          )}
          <div>
            <Button onClick={refresh} testId="refresh">
              Refresh
            </Button>
          </div>
        </Section>
      )}

      <Section title="WHAT IS NOT HERE">
        <Empty>
          There is no live approval count on this page, and adding one would take more than a change
          to this file. While an incident is collecting, the count exists only as a number the
          program computes in memory during certification. It is never written to an account, so
          nothing can read it, including the members themselves.
        </Empty>
        <Card outlined>
          <Fields>
            <Field label="Visible while collecting">
              Incident id, opener, deadline, threshold, member set commitment
            </Field>
            <Field label="Visible only at the end">
              Final approval and rejection counts, terminal status, operation ID
            </Field>
            <Field label="Never visible">
              Any individual ballot, the claim, the evidence, who has answered so far
            </Field>
          </Fields>
        </Card>
      </Section>
    </>
  );
}

function IncidentRow({ incident, search }: { incident: IncidentView; search: string }) {
  const terminal = isTerminal(incident.core.status);
  const operation = hex(incident.core.operationId);
  const hasOperation = !/^0+$/.test(operation);

  return (
    <Card outlined>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "var(--spacing-24)",
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        <div>
          <Eyebrow>Incident {incident.core.incidentId.toString()}</Eyebrow>
          <div style={{ fontSize: "var(--text-subheading)", marginTop: "var(--spacing-8)" }}>
            {IncidentStatus[incident.core.status]}
          </div>
        </div>
        <State tone={terminal ? "good" : "waiting"}>
          {incident.delegated ? "ON THE ROLLUP" : terminal ? "SETTLED TO BASE" : "ON BASE"}
        </State>
      </div>

      <div style={{ margin: "var(--spacing-24) 0" }}>
        <Rule />
      </div>

      <Fields>
        <Field label="Address" mono>
          <Address value={incident.address.toBase58()} />
        </Field>
        <Field label="Opener" mono>
          {shortAddress(incident.core.opener)}
        </Field>
        <Field label="Threshold">
          {incident.core.requiredApprovals} approvals, at most {incident.core.maximumRejections}{" "}
          rejections
        </Field>
        <Field label="Closes at slot" mono>
          {incident.core.expiresAtSlot.toString()}
        </Field>
        {terminal ? (
          <Field label="Final count">
            {incident.core.approvalCountAfterTerminal} approved,{" "}
            {incident.core.rejectionCountAfterTerminal} rejected
          </Field>
        ) : (
          <Field label="Count so far">
            <span style={{ color: "var(--color-steel)" }}>Not knowable. No account holds it.</span>
          </Field>
        )}
        {incident.privacy && (
          <Field label="Private fields">
            <State
              tone={
                incident.privacy.claimZeroized && incident.privacy.ballotsZeroized
                  ? "good"
                  : "blocked"
              }
            >
              {incident.privacy.claimZeroized && incident.privacy.ballotsZeroized
                ? `ZEROIZED (${incident.privacy.ballotCount} ballots)`
                : "NOT ZEROIZED"}
            </State>
          </Field>
        )}
      </Fields>

      {hasOperation && (
        <div style={{ marginTop: "var(--spacing-24)" }}>
          <Link to={{ pathname: "/proof", search: appendOperation(search, operation) }}>
            <Button testId={`verify-${incident.core.incidentId}`}>Verify this operation →</Button>
          </Link>
        </div>
      )}
    </Card>
  );
}

function appendOperation(search: string, operation: string): string {
  const params = new URLSearchParams(search);
  params.set("operation", operation);
  return `?${params.toString()}`;
}

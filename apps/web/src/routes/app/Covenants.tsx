/**
 * Covenants: the list, and one covenant's workspace.
 *
 * The workspace is where "Formation", "Observer", and "Settlement" went. They were never
 * products, they were stages of one thing, and exposing them as top-level navigation is what
 * made the old application read as a technical demo.
 */

import { Link, useLocation, useParams } from "react-router-dom";

import { CovenantStatus } from "@vinct/client";

import { AppShell } from "../../components/AppShell";
import {
  Address,
  Card,
  CardLink,
  Empty,
  Field,
  Fields,
  Loading,
  Note,
  PageHeader,
  Pill,
  Problem,
  Section,
  Technical,
} from "../../components/primitives";
import { DEMO_COVENANT, PROTOCOL_NAMES } from "../../lib/demo";
import { useNetwork } from "../../lib/network";
import {
  covenantName,
  useCovenant,
  useCovenants,
  type CovenantSummary,
} from "../../lib/useCovenants";
import { describeRole, useWallet } from "../../lib/wallet";
import { incidentStatusLabel, incidentStatusMeaning, incidentStatusTone } from "./status";

export function Covenants() {
  const location = useLocation();
  const network = useNetwork();
  const { publicKey } = useWallet();
  const { state } = useCovenants(network, publicKey);
  const search = location.search;

  return (
    <AppShell>
      <PageHeader
        title="Covenants"
        description="Agreements between protocols that share a critical dependency. Each one fixes who is in it, what each protocol will do, and how many have to agree."
        action={
          <Link to={{ pathname: "/app/covenants/new", search }} className="btn btn-sm btn-primary">
            Create covenant
          </Link>
        }
      />

      {state.status === "loading" && <Loading rows={3} />}
      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "unsupported" && <Problem kind="unsupported" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}

      {state.status === "ready" &&
        (state.value.length === 0 ? (
          <Empty
            title="No covenants on this cluster"
            action={
              <Link to={{ pathname: "/demo", search }} className="btn btn-sm btn-signal">
                Explore the demo covenant
              </Link>
            }
          >
            Either nothing has been formed here, or this wallet is not a member of anything yet.
          </Empty>
        ) : (
          <Card className="card-flush">
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Covenant</th>
                    <th>Members</th>
                    <th>Threshold</th>
                    <th>Your role</th>
                    <th>Incidents</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {state.value.map((summary) => (
                    <tr key={summary.address.toBase58()}>
                      <td data-label="Covenant">
                        <Link
                          to={{
                            pathname: `/app/covenants/${summary.address.toBase58()}`,
                            search,
                          }}
                          className="row"
                          style={{ gap: "var(--s2)" }}
                        >
                          <span style={{ fontWeight: 500 }}>{covenantName(summary)}</span>
                          {summary.address.toBase58() === DEMO_COVENANT && <Pill>Demo</Pill>}
                        </Link>
                      </td>
                      <td data-label="Members">{summary.members.length}</td>
                      <td data-label="Threshold">
                        {summary.covenant.requiredApprovals} of {summary.covenant.memberCount}
                      </td>
                      <td data-label="Your role">
                        <span className="muted">{describeRole(summary.role)}</span>
                      </td>
                      <td data-label="Incidents">{summary.incidents.length}</td>
                      <td data-label="Status">
                        <Pill tone={summary.ready ? "ok" : "waiting"}>
                          {summary.ready ? "Ready" : CovenantStatus[summary.covenant.status]}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
    </AppShell>
  );
}

/** One covenant, and everything about it in one place. */
export function CovenantWorkspace() {
  const { covenantId } = useParams();
  const location = useLocation();
  const network = useNetwork();
  const { publicKey } = useWallet();
  const { state, covenant } = useCovenant(network, publicKey, covenantId);
  const search = location.search;

  if (state.status === "loading") {
    return (
      <AppShell>
        <Loading rows={5} />
      </AppShell>
    );
  }
  if (state.status !== "ready") {
    return (
      <AppShell>
        <Problem
          kind={
            state.status === "unreachable"
              ? "unreachable"
              : state.status === "unsupported"
                ? "unsupported"
                : "error"
          }
          message={state.message}
        />
      </AppShell>
    );
  }
  if (!covenant) {
    return (
      <AppShell>
        <Empty
          title="No covenant at that address"
          action={
            <Link to={{ pathname: "/app/covenants", search }} className="btn btn-sm">
              Back to covenants
            </Link>
          }
        >
          Either the address is wrong, or this is a different cluster from the one it was formed on.
        </Empty>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        back={{ to: `/app/covenants${search}`, label: "Covenants" }}
        title={covenantName(covenant)}
        description="Formed in advance. Every member arms its own adapter, and no member can act for another."
        badge={
          <Pill tone={covenant.ready ? "ok" : "waiting"}>
            {covenant.ready ? "Ready" : CovenantStatus[covenant.covenant.status]}
          </Pill>
        }
      />

      <div className="grid-stats" style={{ marginBottom: "var(--s6)" }}>
        <Card>
          <Field label="Shared dependency">
            {covenant.address.toBase58() === DEMO_COVENANT
              ? "Pyth SOL/USD price feed"
              : "Recorded off chain"}
          </Field>
        </Card>
        <Card>
          <Field label="Threshold">
            {covenant.covenant.requiredApprovals} of {covenant.covenant.memberCount} must approve
          </Field>
        </Card>
        <Card>
          <Field label="Response window">
            {covenant.covenant.responseWindowSlots.toString()} slots
          </Field>
        </Card>
        <Card>
          <Field label="Your role">{describeRole(covenant.role)}</Field>
        </Card>
      </div>

      <Section
        title="Readiness"
        description="A covenant is ready only when every member has ratified and armed its own adapter."
      >
        <Card className="card-flush">
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Protocol</th>
                  <th>Membership</th>
                  <th>Adapter</th>
                  <th>Address</th>
                </tr>
              </thead>
              <tbody>
                {covenant.members.map((entry, index) => (
                  <tr key={entry.address.toBase58()}>
                    <td data-label="Protocol">
                      <span style={{ fontWeight: 500 }}>
                        {Object.values(PROTOCOL_NAMES)[index] ??
                          `Protocol ${entry.member.protocol.toBase58().slice(0, 4)}`}
                      </span>
                    </td>
                    <td data-label="Membership">
                      <Pill tone={entry.member.ratified ? "ok" : "waiting"}>
                        {entry.member.ratified ? "Ratified" : "Not ratified"}
                      </Pill>
                    </td>
                    <td data-label="Adapter">
                      <Pill tone={entry.member.armed ? "ok" : "waiting"}>
                        {entry.member.armed ? `Armed v${entry.member.adapterVersion}` : "Not armed"}
                      </Pill>
                    </td>
                    <td data-label="Address">
                      <Address value={entry.member.protocol.toBase58()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Note title="Nobody can form this alone">
          The steward names members and can do nothing else. Each protocol ratifies and arms with
          its own key. The two covenant-level steps need no signature at all, because by the time
          they run every signature that mattered has already been given.
        </Note>
      </Section>

      <Section title="Incidents" description="Every incident opened under this covenant.">
        {covenant.incidents.length === 0 ? (
          <Empty
            title="No incidents"
            action={
              <Link to={{ pathname: "/demo", search }} className="btn btn-sm">
                See what one looks like
              </Link>
            }
          >
            This covenant is armed and nothing has happened. That is the normal state.
          </Empty>
        ) : (
          <div className="stack">
            {covenant.incidents.map((incident) => (
              <CardLink
                key={incident.address.toBase58()}
                to={`/app/covenants/${covenant.address.toBase58()}/incidents/${incident.address.toBase58()}${search}`}
                testId="incident-row"
              >
                <div className="row-between">
                  <div className="stack-sm">
                    <div className="t-lead" style={{ fontWeight: 500 }}>
                      Incident {incident.core.incidentId.toString()}
                    </div>
                    <div className="t-small muted">
                      {incidentStatusMeaning(incident.core.status)}
                    </div>
                  </div>
                  <Pill tone={incidentStatusTone(incident.core.status)}>
                    {incidentStatusLabel(incident.core.status)}
                  </Pill>
                </div>
              </CardLink>
            ))}
          </div>
        )}
      </Section>

      <Technical>
        <Fields>
          <Field label="Covenant address" mono>
            <Address value={covenant.address.toBase58()} full />
          </Field>
          <Field label="Steward" mono>
            <Address value={covenant.covenant.steward.toBase58()} full />
          </Field>
          <Field label="Epoch" mono>
            {covenant.covenant.circleEpoch.toString()}
          </Field>
          <Field label="Frozen member set" mono>
            {hex(covenant.covenant.memberSetHash)}
          </Field>
          <Field label="Policy" mono>
            {hex(covenant.covenant.policyId)}
          </Field>
          <Field label="Action template" mono>
            {hex(covenant.covenant.actionBundleTemplateHash)}
          </Field>
        </Fields>
      </Technical>
    </AppShell>
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type { CovenantSummary };

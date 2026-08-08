/**
 * The operator's console.
 *
 * It exists to answer one question fast: do I need to do anything. So the first thing on the
 * page is the count of things that need this wallet, and if that count is zero it says so
 * plainly rather than making somebody read four panels to find out.
 *
 * Disconnected is a first-class state rather than a wall. A visitor sees the demo covenant and
 * a reason to connect, not an empty screen.
 */

import { Link, useLocation } from "react-router-dom";

import { IncidentStatus } from "@vinct/client";

import { AppShell } from "../../components/AppShell";
import {
  Card,
  CardLink,
  Empty,
  Loading,
  Pill,
  Problem,
  Section,
  Stat,
} from "../../components/primitives";
import {
  covenantName,
  needsAttention,
  useCovenants,
  type CovenantSummary,
} from "../../lib/useCovenants";
import { useNetwork } from "../../lib/network";
import { useWallet } from "../../lib/wallet";
import { DEMO_COVENANT } from "../../lib/demo";

export function AppHome() {
  const location = useLocation();
  const network = useNetwork();
  const { publicKey } = useWallet();
  const { state } = useCovenants(network, publicKey);
  const search = location.search;

  return (
    <AppShell>
      <header className="row-between" style={{ marginBottom: "var(--s6)", alignItems: "flex-end" }}>
        <div>
          <h1 className="t-page">{greeting()}</h1>
          <p className="t-body muted" style={{ marginTop: 4 }}>
            {publicKey
              ? "Everything below is read from the chain. Nothing is signed until you approve it."
              : "You are reading VINCT without a wallet, which is enough for everything except acting."}
          </p>
        </div>
      </header>

      {state.status === "loading" && <Loading rows={4} />}
      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "unsupported" && (
        <Problem
          kind="unsupported"
          message={state.message}
          action={
            <Link to={{ pathname: "/app/covenants", search }} className="btn btn-sm">
              Open a covenant by address
            </Link>
          }
        />
      )}
      {state.status === "error" && <Problem kind="error" message={state.message} />}

      {state.status === "ready" && (
        <Ready summaries={state.value} search={search} connected={publicKey !== null} />
      )}
    </AppShell>
  );
}

function Ready({
  summaries,
  search,
  connected,
}: {
  summaries: CovenantSummary[];
  search: string;
  connected: boolean;
}) {
  const attention = needsAttention(summaries);
  const mine = summaries.filter(
    (entry) => entry.role.kind !== "unrelated" && entry.role.kind !== "disconnected",
  );
  const armed = summaries.flatMap((entry) =>
    entry.capabilities.filter((capability) => capability.armed && !capability.suspended),
  );
  const settled = summaries.flatMap((entry) =>
    entry.incidents.filter(
      (incident) => incident.core.status === IncidentStatus.CertifiedPendingSettlement,
    ),
  );

  return (
    <>
      <div className="grid-stats" style={{ marginBottom: "var(--s7)" }}>
        <Card tone={attention.length > 0 ? "attention" : undefined}>
          <Stat
            label="Needs you"
            value={attention.length}
            tone={attention.length > 0 ? "attention" : undefined}
            hint={
              attention.length > 0
                ? "an incident is collecting responses"
                : "nothing is waiting on your response"
            }
          />
        </Card>
        <Card>
          <Stat
            label="Your covenants"
            value={connected ? mine.length : "—"}
            hint={connected ? "you are a member or steward" : "connect to see yours"}
          />
        </Card>
        <Card>
          <Stat label="Armed adapters" value={armed.length} hint="across every covenant in view" />
        </Card>
        <Card>
          <Stat label="Certified incidents" value={settled.length} hint="reached their threshold" />
        </Card>
      </div>

      {attention.length > 0 && (
        <Section
          title="Requires your attention"
          description="An incident is collecting responses and you are in its member set."
        >
          <div className="stack">
            {attention.map(({ covenant, incident }) => (
              <CardLink
                key={incident.address.toBase58()}
                to={`/app/covenants/${covenant.address.toBase58()}/incidents/${incident.address.toBase58()}${search}`}
                className="card-attention"
                testId="attention-incident"
              >
                <div className="row-between">
                  <div className="stack-sm">
                    <div className="label">{covenantName(covenant)}</div>
                    <div className="t-title">
                      Incident {incident.core.incidentId.toString()} needs your response
                    </div>
                    <div className="t-small muted">
                      Closes at slot {incident.core.expiresAtSlot.toString()}. Your answer is sealed
                      from every other member.
                    </div>
                  </div>
                  <Pill tone="attention">Respond</Pill>
                </div>
              </CardLink>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Covenants"
        description="Agreements you belong to, and the demonstration covenant."
        action={
          <Link to={{ pathname: "/app/covenants", search }} className="btn btn-sm">
            All covenants
          </Link>
        }
      >
        {summaries.length === 0 ? (
          <Empty
            title="No covenants found"
            action={
              <Link to={{ pathname: "/demo", search }} className="btn btn-signal btn-sm">
                Explore the demo
              </Link>
            }
          >
            Nothing on this cluster matches. The guided demo shows a real covenant end to end.
          </Empty>
        ) : (
          <div className="stack">
            {summaries.slice(0, 4).map((summary) => (
              <CardLink
                key={summary.address.toBase58()}
                to={`/app/covenants/${summary.address.toBase58()}${search}`}
                testId="covenant-row"
              >
                <div className="row-between">
                  <div className="stack-sm">
                    <div className="row" style={{ gap: "var(--s2)" }}>
                      <span className="t-lead" style={{ fontWeight: 500 }}>
                        {covenantName(summary)}
                      </span>
                      {summary.address.toBase58() === DEMO_COVENANT && <Pill>Demo</Pill>}
                    </div>
                    <div className="t-small muted">
                      {summary.members.length} members · {summary.covenant.requiredApprovals} of{" "}
                      {summary.covenant.memberCount} threshold · {summary.incidents.length} incident
                      {summary.incidents.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Pill tone={summary.ready ? "ok" : "waiting"}>
                    {summary.ready ? "Ready" : "Not armed"}
                  </Pill>
                </div>
              </CardLink>
            ))}
          </div>
        )}
      </Section>

      {!connected && (
        <Empty
          title="Connect to see your own memberships"
          action={
            <>
              <Link to={{ pathname: "/demo", search }} className="btn btn-sm">
                Explore the demo instead
              </Link>
            </>
          }
        >
          A wallet tells VINCT which protocol you represent, which covenants you belong to, and
          which incidents are waiting on you. Reading never requires one.
        </Empty>
      )}
    </>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

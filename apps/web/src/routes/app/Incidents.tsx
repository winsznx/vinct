/**
 * Every incident, across every covenant in view.
 *
 * Failure states stay distinct. "Failed" would collapse an incident nobody answered, one the
 * circle declined, and a cohort that was scheduled and stripped into one word, and those need
 * three different responses.
 */

import { Link, useLocation } from "react-router-dom";

import { AppShell } from "../../components/AppShell";
import { Card, Empty, Loading, PageHeader, Pill, Problem } from "../../components/primitives";
import { useNetwork } from "../../lib/network";
import { covenantName, useCovenants } from "../../lib/useCovenants";
import { useWallet } from "../../lib/wallet";
import { incidentStatusLabel, incidentStatusMeaning, incidentStatusTone } from "./status";

export function Incidents() {
  const location = useLocation();
  const network = useNetwork();
  const { publicKey } = useWallet();
  const { state } = useCovenants(network, publicKey);
  const search = location.search;

  return (
    <AppShell>
      <PageHeader
        title="Incidents"
        description="Every incident opened under a covenant in view, with what each one actually resolved to."
      />

      {state.status === "loading" && <Loading rows={3} />}
      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "unsupported" && <Problem kind="unsupported" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}

      {state.status === "ready" &&
        (state.value.every((summary) => summary.incidents.length === 0) ? (
          <Empty
            title="No incidents"
            action={
              <Link to={{ pathname: "/demo", search }} className="btn btn-sm btn-signal">
                Walk through a recorded one
              </Link>
            }
          >
            Nothing has been opened on this cluster. For a covenant that is armed and quiet, that is
            the state you want.
          </Empty>
        ) : (
          <Card className="card-flush">
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Incident</th>
                    <th>Covenant</th>
                    <th>What happened</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {state.value.flatMap((summary) =>
                    summary.incidents.map((incident) => (
                      <tr key={incident.address.toBase58()}>
                        <td data-label="Incident">
                          <Link
                            to={{
                              pathname: `/app/covenants/${summary.address.toBase58()}/incidents/${incident.address.toBase58()}`,
                              search,
                            }}
                            style={{ fontWeight: 500 }}
                          >
                            #{incident.core.incidentId.toString()}
                          </Link>
                        </td>
                        <td data-label="Covenant">
                          <span className="muted">{covenantName(summary)}</span>
                        </td>
                        <td data-label="What happened">
                          <span className="muted">
                            {incidentStatusMeaning(incident.core.status)}
                          </span>
                        </td>
                        <td data-label="State">
                          <Pill tone={incidentStatusTone(incident.core.status)}>
                            {incidentStatusLabel(incident.core.status)}
                          </Pill>
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
    </AppShell>
  );
}

/**
 * The private room, and the wall this browser stands behind.
 *
 * A member's ballot lives in an account permissioned to that member alone, inside a private
 * ephemeral rollup. Reading it needs an authenticated connection to that rollup, signed by the
 * member's own key. This page holds no key and opens no such connection, so it shows the room's
 * shape and not its contents.
 *
 * That is a real limit and it is stated as one. The alternative, a browser that held member keys
 * and cached decrypted ballots, would move private material outside the boundary the whole
 * design exists to hold. See docs/privacy-boundary.md.
 *
 * Nothing on this page is written to storage. `tests/web/privacy.spec.ts` asserts it.
 */

import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";

import { PublicKey } from "@solana/web3.js";
import { IncidentStatus, attestationAddress, claimAddress } from "@vinct/client";

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
  findCovenantMembers,
  findIncidents,
  isTerminal,
  shortAddress,
} from "../data/chain";
import { readEndpoints, recallCovenant } from "../data/config";
import { usePolled } from "../data/useChain";

export function IncidentRoom() {
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

  const { state } = usePolled(async () => {
    if (!covenant) return null;
    const connection = connect(endpoints.base);
    const incidents = await findIncidents(connection, covenant);
    const live = incidents.filter((incident) => !isTerminal(incident.core.status));
    const target = live[live.length - 1] ?? incidents[incidents.length - 1] ?? null;
    if (!target) return { incident: null, members: [] };
    return { incident: target, members: await findCovenantMembers(connection, covenant) };
  }, [endpoints.base, covenant?.toBase58()]);

  const incident = state.status === "ready" ? (state.value?.incident ?? null) : null;

  return (
    <>
      <Eyebrow>Private to the member set. This browser is outside it.</Eyebrow>
      <Stamp>INCIDENT ROOM</Stamp>
      <p style={{ maxWidth: 720, marginTop: "var(--spacing-24)" }}>
        The claim and every ballot live in separate accounts on a private rollup, each permissioned
        to exactly one reader. This page shows which accounts exist and what state they are in. It
        does not show what is in them, and it could not: it holds no member key and opens no
        authenticated rollup connection.
      </p>

      {!covenant && (
        <div style={{ marginTop: "var(--spacing-48)" }}>
          <Empty>No covenant selected. Open Formation to point this page at one.</Empty>
        </div>
      )}

      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}
      {state.status === "unsupported" && <Problem kind="unsupported" message={state.message} />}

      {covenant && state.status === "ready" && !incident && (
        <Empty>This covenant has no incident to show.</Empty>
      )}

      {incident && state.status === "ready" && (
        <>
          <Section title="THE ROOM">
            <Card outlined>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "var(--spacing-16)",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                }}
              >
                <div>
                  <Eyebrow>Incident {incident.core.incidentId.toString()}</Eyebrow>
                  <div
                    style={{ fontSize: "var(--text-subheading)", marginTop: "var(--spacing-8)" }}
                  >
                    {IncidentStatus[incident.core.status]}
                  </div>
                </div>
                <State tone={incident.delegated ? "attention" : "good"}>
                  {incident.delegated ? "LIVE ON THE ROLLUP" : "RETURNED TO BASE"}
                </State>
              </div>

              <div style={{ margin: "var(--spacing-24) 0" }}>
                <Rule />
              </div>

              <Fields>
                <Field label="Claim account" mono>
                  <Address value={shortAddress(claimAddress(incident.address))} />
                </Field>
                <Field label="Readable by">
                  {incident.delegated
                    ? "the member set, inside the rollup"
                    : "nobody; it was scrubbed"}
                </Field>
                <Field label="Ballot accounts">
                  {state.value?.members.length ?? 0}, one per member
                </Field>
                <Field label="Each readable by">
                  {incident.delegated ? "exactly one member" : "nobody; they were scrubbed"}
                </Field>
              </Fields>
            </Card>
          </Section>

          <Section title="BALLOTS">
            <Empty>
              One account per member, created before the incident opened and whether or not that
              member ever answers. An account that appeared only when somebody voted would announce
              that they had.
            </Empty>
            <div style={{ display: "grid" }} data-testid="ballot-list">
              {(state.value?.members ?? []).map(({ member }) => (
                <div key={member.protocol.toBase58()}>
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
                    <Address value={shortAddress(member.protocol)} />
                    <span
                      className="mono"
                      style={{ color: "var(--color-graphite)", flex: "1 1 200px" }}
                    >
                      {shortAddress(attestationAddress(incident.address, member.protocol))}
                    </span>
                    <State tone="waiting">{incident.delegated ? "SEALED" : "SCRUBBED"}</State>
                  </div>
                </div>
              ))}
              <Rule />
            </div>
            <Empty>
              Sealed means this browser cannot tell whether that member has answered, and neither
              can any other member. The state was tested: a co-member reading a peer&rsquo;s ballot
              account through the rollup&rsquo;s query service is refused, not merely discouraged.
            </Empty>
          </Section>
        </>
      )}

      <Section title="HOW A MEMBER ACTUALLY VOTES">
        <Empty>
          Not here. Submitting an attestation needs the member&rsquo;s own key and an authenticated
          connection to the rollup that holds their ballot, and this page is deliberately unable to
          do either.
        </Empty>
        <Card outlined>
          <pre
            className="mono"
            style={{
              margin: 0,
              overflowX: "auto",
              lineHeight: 1.7,
              color: "var(--color-almost-white)",
            }}
          >
            {`submitSealedAttestation(core, member, Decision.Approve, nonce)`}
          </pre>
          <p
            style={{ color: "var(--color-steel)", marginBottom: 0, marginTop: "var(--spacing-16)" }}
          >
            Signed by the member, sent to the router-resolved rollup endpoint. The decision never
            reaches this origin, this browser&rsquo;s storage, or any log.
          </p>
        </Card>
        <div>
          <Link to={{ pathname: "/observer", search: location.search }}>
            <Button>What an observer sees instead →</Button>
          </Link>
        </div>
      </Section>
    </>
  );
}

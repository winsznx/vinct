/**
 * One incident, seen differently depending on who is looking.
 *
 * A non-member sees what the covenant lets the world see: that an incident exists, when it
 * closes, and what it settled to. A member additionally sees that they are a member, and can
 * answer.
 *
 * Three things this page must never render, and the reason each one is a leak:
 *
 *   a live approval count, because knowing two of three have approved is a tradeable fact;
 *   which members have responded, because that is the same fact in a different shape;
 *   any other member's answer, which is the property the whole product is built around.
 *
 * There is no progress bar for the quorum, and its absence is stated rather than left as a gap.
 * A page that quietly omitted the count would look like one that had failed to load it, and the
 * distinction between "hidden" and "does not exist anywhere" is the interesting one: while an
 * incident is collecting, no account holds that number at all.
 *
 * Submitting an attestation needs an authenticated connection to the rollup holding the ballot,
 * signed by the member's own key. That path is deliberately not built into this browser, and the
 * page says so and shows the exact call instead of pretending.
 */

import { Link, useLocation, useParams } from "react-router-dom";

import { IncidentStatus, attestationAddress, claimAddress } from "@vinct/client";

import { AppShell } from "../../components/AppShell";
import {
  Address,
  Card,
  Empty,
  Field,
  Fields,
  Loading,
  Note,
  PageHeader,
  Pill,
  Problem,
  Sealed,
  Section,
  Technical,
} from "../../components/primitives";
import { PROTOCOL_NAMES } from "../../lib/demo";
import { useNetwork } from "../../lib/network";
import { covenantName, useCovenant } from "../../lib/useCovenants";
import { useWallet } from "../../lib/wallet";
import { Respond } from "./Respond";
import { incidentStatusLabel, incidentStatusMeaning, incidentStatusTone } from "./status";

export function IncidentRoom() {
  const { covenantId, incidentId } = useParams();
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

  const incident = covenant?.incidents.find((entry) => entry.address.toBase58() === incidentId);

  if (!covenant || !incident) {
    return (
      <AppShell>
        <Empty
          title="No incident at that address"
          action={
            <Link to={{ pathname: "/app/incidents", search }} className="btn btn-sm">
              All incidents
            </Link>
          }
        >
          Either the address is wrong, or this is a different cluster from the one it was opened on.
        </Empty>
      </AppShell>
    );
  }

  const collecting = incident.core.status === IncidentStatus.Collecting;
  const terminal = !collecting && incident.core.status !== IncidentStatus.Draft;

  return (
    <AppShell>
      <PageHeader
        back={{
          to: `/app/covenants/${covenant.address.toBase58()}${search}`,
          label: covenantName(covenant),
        }}
        title={`Incident ${incident.core.incidentId.toString()}`}
        description={incidentStatusMeaning(incident.core.status)}
        badge={
          <Pill tone={incidentStatusTone(incident.core.status)}>
            {incidentStatusLabel(incident.core.status)}
          </Pill>
        }
      />

      {/* ------------------------------------------------- the member's view */}
      {collecting && (
        <Respond
          network={network}
          incident={incident.address}
          members={covenant.members.map((entry) => entry.member.protocol)}
        />
      )}

      {/* -------------------------------------------- what is knowable, and not */}
      <Section title="What is knowable right now">
        <div className="grid-2">
          <Card>
            <div className="stack">
              <Fields>
                <Field label="Threshold">
                  {incident.core.requiredApprovals} of {covenant.members.length} must approve
                </Field>
                <Field label="Closes at slot" mono>
                  {incident.core.expiresAtSlot.toString()}
                </Field>
                <Field label="Opened by" mono>
                  <Address value={incident.core.opener.toBase58()} />
                </Field>
                <Field label="Where the state lives">
                  {incident.delegated ? "On the rollup" : "Returned to base"}
                </Field>
              </Fields>

              <hr className="sep" />

              <Field label={terminal ? "Final count" : "Responses so far"}>
                {terminal ? (
                  <span>
                    {incident.core.approvalCountAfterTerminal} approved,{" "}
                    {incident.core.rejectionCountAfterTerminal} declined
                  </span>
                ) : (
                  <Sealed note="No account holds this number while an incident is collecting. It exists only inside certification, and only for the moment it runs." />
                )}
              </Field>
            </div>
          </Card>

          <Card>
            <div className="stack">
              <div className="label">Members</div>
              {covenant.members.map((entry, index) => (
                <div
                  key={entry.address.toBase58()}
                  className="row-between"
                  style={{ gap: "var(--s3)" }}
                >
                  <span className="t-body">
                    {Object.values(PROTOCOL_NAMES)[index] ??
                      `Protocol ${entry.member.protocol.toBase58().slice(0, 4)}`}
                    {publicKey?.equals(entry.member.protocol) && (
                      <span className="muted"> · you</span>
                    )}
                  </span>
                  {terminal ? (
                    <Pill>Scrubbed</Pill>
                  ) : (
                    <Pill tone="waiting" title="Nobody can tell whether this member has answered">
                      Sealed
                    </Pill>
                  )}
                </div>
              ))}
              <hr className="sep" />
              <p className="t-small muted">
                Every member has a ballot account, created before the incident opened whether or not
                they ever answer. An account that appeared only on voting would announce that
                somebody had.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      {/* --------------------------------------------------------- settlement */}
      {terminal && (
        <Section
          title="Settlement"
          description="Read from base-layer accounts, never from the transaction that scheduled the actions."
        >
          <SettlementTimeline incident={incident} search={search} />
        </Section>
      )}

      {/* ---------------------------------------------------------- privacy */}
      {incident.privacy && (
        <Section title="Private fields">
          <Card>
            <Fields>
              <Field label="Claim">
                <Pill tone={incident.privacy.claimZeroized ? "ok" : "blocked"}>
                  {incident.privacy.claimZeroized ? "Erased" : "Not erased"}
                </Pill>
              </Field>
              <Field label="Ballots">
                <Pill tone={incident.privacy.ballotsZeroized ? "ok" : "blocked"}>
                  {incident.privacy.ballotsZeroized
                    ? `${incident.privacy.ballotCount} erased`
                    : "Not erased"}
                </Pill>
              </Field>
            </Fields>
            <p className="t-base muted" style={{ marginTop: "var(--s4)" }}>
              When an incident ends, the claim and every ballot are overwritten before the accounts
              leave the rollup. The program refuses to release them otherwise, checking both the
              flag and the bytes themselves.
            </p>
          </Card>
        </Section>
      )}

      <Technical>
        <Fields>
          <Field label="Incident" mono>
            <Address value={incident.address.toBase58()} full />
          </Field>
          <Field label="Claim account" mono>
            <Address value={claimAddress(incident.address).toBase58()} full />
          </Field>
          {publicKey && (
            <Field label="Your ballot account" mono>
              <Address value={attestationAddress(incident.address, publicKey).toBase58()} full />
            </Field>
          )}
          <Field label="Operation" mono>
            {hex(incident.core.operationId)}
          </Field>
        </Fields>
      </Technical>
    </AppShell>
  );
}

/**
 * What the cohort was supposed to do, and what was seen.
 *
 * Deliberately a sequence rather than a status. The interesting thing about VINCT's settlement
 * is the gap between "the intent was accepted" and "the effects exist", and a single badge
 * hides exactly that.
 */
function SettlementTimeline({
  incident,
  search,
}: {
  incident: import("../../data/chain").IncidentView;
  search: string;
}) {
  const operation = hex(incident.core.operationId);
  const hasOperation = !/^0+$/.test(operation);

  if (!hasOperation) {
    return (
      <Empty
        title="Nothing to settle"
        action={
          <Link to={{ pathname: "/app/incidents", search }} className="btn btn-sm">
            Other incidents
          </Link>
        }
      >
        This incident did not reach its threshold, so no certificate exists and no protocol action
        was authorised.
      </Empty>
    );
  }

  return (
    <Card>
      <div className="stack">
        <p className="t-body muted">
          A scheduling signature means an intent was accepted. Whether the actions ran is a separate
          question with a separate answer, and the verifier reads that answer off the base layer one
          effect at a time.
        </p>
        <Link
          to={{ pathname: `/proof/${operation}`, search }}
          className="btn btn-signal"
          data-testid="verify-from-incident"
        >
          Verify this operation
        </Link>
      </div>
    </Card>
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

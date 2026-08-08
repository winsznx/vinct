/**
 * What each protocol authorised, in the protocol's own terms.
 *
 * The point this page has to land is that VINCT never receives admin authority. So it leads
 * with a sentence in plain language about what the capability permits, and puts the struct
 * behind a disclosure. A protocol operator deciding whether to arm is not reading a 32-byte
 * template digest, and a judge checking the work needs it exactly.
 */

import { Link, useLocation } from "react-router-dom";

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
  Section,
  Technical,
} from "../../components/primitives";
import { PROTOCOL_NAMES } from "../../lib/demo";
import { useNetwork } from "../../lib/network";
import { covenantName, useCovenants } from "../../lib/useCovenants";
import { useWallet } from "../../lib/wallet";

export function Adapters() {
  const location = useLocation();
  const network = useNetwork();
  const { publicKey } = useWallet();
  const { state } = useCovenants(network, publicKey);
  const search = location.search;

  return (
    <AppShell>
      <PageHeader
        title="Adapters"
        description="One bounded action each protocol permits against its own contracts. Yours stay yours: VINCT holds no authority over any of them and cannot act on your behalf."
      />

      {state.status === "loading" && <Loading rows={3} />}
      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "unsupported" && <Problem kind="unsupported" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}

      {state.status === "ready" && (
        <>
          {state.value.every((summary) => summary.capabilities.length === 0) ? (
            <Empty
              title="No adapters armed"
              action={
                <Link to={{ pathname: "/demo", search }} className="btn btn-sm btn-signal">
                  See an armed covenant
                </Link>
              }
            >
              A capability is armed by a protocol against its own contracts, before any incident
              exists. Nothing on this cluster has one yet.
            </Empty>
          ) : (
            state.value
              .filter((summary) => summary.capabilities.length > 0)
              .map((summary) => (
                <Section
                  key={summary.address.toBase58()}
                  title={covenantName(summary)}
                  description={`${summary.capabilities.length} armed against this covenant`}
                >
                  <div className="stack">
                    {summary.capabilities.map((capability, index) => {
                      const mine = publicKey?.equals(capability.authority) ?? false;
                      const name =
                        Object.values(PROTOCOL_NAMES)[index] ??
                        `Protocol ${capability.authority.toBase58().slice(0, 4)}`;
                      return (
                        <Card key={capability.address.toBase58()}>
                          <div className="stack">
                            <div className="row-between">
                              <div className="stack-sm">
                                <div className="row" style={{ gap: "var(--s2)" }}>
                                  <span className="t-lead" style={{ fontWeight: 500 }}>
                                    {name}
                                  </span>
                                  {mine && <Pill tone="attention">Yours</Pill>}
                                </div>
                                <p className="t-base muted" style={{ maxWidth: "62ch" }}>
                                  {name} authorises one emergency action: pause new borrowing on its
                                  own market, and only when a certificate matches this covenant,
                                  this policy, and this member set.
                                </p>
                              </div>
                              <div className="row" style={{ gap: "var(--s2)" }}>
                                <Pill tone={capability.armed ? "ok" : "waiting"}>
                                  {capability.armed ? "Armed" : "Not armed"}
                                </Pill>
                                <Pill tone={capability.suspended ? "blocked" : "ok"}>
                                  {capability.suspended ? "Suspended" : "Active"}
                                </Pill>
                              </div>
                            </div>

                            {mine && (
                              <div className="row" style={{ flexWrap: "wrap", gap: "var(--s3)" }}>
                                <button type="button" className="btn btn-sm" disabled>
                                  {capability.suspended ? "Resume" : "Suspend"}
                                </button>
                                <span className="t-small muted">
                                  Signing is done from your protocol&rsquo;s own tooling, not from
                                  this page.
                                </span>
                              </div>
                            )}

                            <Technical>
                              <Fields>
                                <Field label="Capability" mono>
                                  <Address value={capability.address.toBase58()} full />
                                </Field>
                                <Field label="Protocol authority" mono>
                                  <Address value={capability.authority.toBase58()} full />
                                </Field>
                              </Fields>
                            </Technical>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </Section>
              ))
          )}

          <Note title="What a certificate cannot do">
            Call any other instruction, reach any other account, act twice, or outlive your
            suspension. Each of those is refused by your adapter rather than by policy, and a
            capability suspended after a certificate exists still refuses.
          </Note>
        </>
      )}
    </AppShell>
  );
}

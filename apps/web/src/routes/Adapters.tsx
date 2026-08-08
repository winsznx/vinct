/**
 * What each protocol actually authorised, in the terms it authorised them.
 *
 * The claim this page has to make legible is that the circle never receives admin authority.
 * So the layout leads with the bound, not with the protocol: one instruction, one target, one
 * effect ceiling, one validity window, all set by the protocol before any incident existed.
 *
 * The suspend state is shown next to the armed state deliberately. A capability suspended after
 * a certificate exists still refuses, and that is the sentence a sceptical protocol operator
 * wants to see.
 */

import { useMemo } from "react";
import { useLocation } from "react-router-dom";

import { PublicKey } from "@solana/web3.js";

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
} from "../components/ui";
import { connect, findCapabilities, hex, shortAddress } from "../data/chain";
import { readEndpoints, recallCovenant } from "../data/config";
import { usePolled } from "../data/useChain";

export function Adapters() {
  const location = useLocation();
  const endpoints = readEndpoints(location.search);
  const covenantParam = new URLSearchParams(location.search).get("covenant") ?? recallCovenant();

  const covenant = useMemo(() => {
    if (!covenantParam) return null;
    try {
      return new PublicKey(covenantParam);
    } catch {
      return null;
    }
  }, [covenantParam]);

  const { state } = usePolled(
    async () => (covenant ? findCapabilities(connect(endpoints.base), covenant) : []),
    [endpoints.base, covenant?.toBase58()],
    8_000,
  );

  return (
    <>
      <Eyebrow>Owned by each protocol. Revocable by each protocol. Always.</Eyebrow>
      <Stamp>ADAPTERS</Stamp>
      <p style={{ maxWidth: 720, marginTop: "var(--spacing-24)" }}>
        A capability is not a grant of authority to the circle. It is a bound a protocol places on
        itself: one instruction it will accept, one account it will accept it against, one effect
        ceiling, and a window outside which nothing is accepted at all.
      </p>

      {!covenant && (
        <div style={{ marginTop: "var(--spacing-48)" }}>
          <Empty>No covenant selected. Open Formation to point this page at one.</Empty>
        </div>
      )}

      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}
      {state.status === "unsupported" && <Problem kind="unsupported" message={state.message} />}

      {covenant && state.status === "ready" && (
        <Section title="ARMED CAPABILITIES">
          {state.value.length === 0 ? (
            <Empty>No capability is armed against this covenant.</Empty>
          ) : (
            <div
              style={{ display: "grid", gap: "var(--spacing-32)" }}
              data-testid="capability-list"
            >
              {state.value.map((entry) => {
                const { capability } = entry;
                return (
                  <Card key={entry.address.toBase58()} outlined>
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
                        <Eyebrow>Protocol authority</Eyebrow>
                        <div style={{ marginTop: "var(--spacing-8)" }}>
                          <Address value={shortAddress(capability.protocolAuthority)} />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "var(--spacing-16)", flexWrap: "wrap" }}>
                        <State tone={capability.armed ? "good" : "waiting"}>
                          {capability.armed ? "ARMED" : "NOT ARMED"}
                        </State>
                        <State tone={capability.suspended ? "blocked" : "good"}>
                          {capability.suspended ? "SUSPENDED" : "ACTIVE"}
                        </State>
                      </div>
                    </div>

                    <div style={{ margin: "var(--spacing-24) 0" }}>
                      <Rule />
                    </div>

                    <Fields>
                      <Field label="Target program" mono>
                        {shortAddress(capability.targetProgram)}
                      </Field>
                      <Field label="Instruction" mono>
                        {hex(capability.instructionDiscriminator)}
                      </Field>
                      <Field label="Protocol state" mono>
                        {shortAddress(capability.protocolState)}
                      </Field>
                      <Field label="May pause">
                        {capability.maxEffect.mayPause ? "yes" : "no"}
                      </Field>
                      <Field label="May unpause">
                        {capability.maxEffect.mayUnpause ? "yes" : "no"}
                      </Field>
                      <Field label="Max value moved" mono>
                        {capability.maxEffect.maxValueMoved.toString()}
                      </Field>
                      <Field label="Valid from slot" mono>
                        {capability.validFromSlot.toString()}
                      </Field>
                      <Field label="Expires at slot" mono>
                        {capability.expiresAtSlot.toString()}
                      </Field>
                      <Field label="Operations executed" mono>
                        {capability.capabilityNonce.toString()}
                      </Field>
                      {entry.marketPaused !== null && (
                        <Field label="Target state">
                          <State tone={entry.marketPaused ? "attention" : "good"}>
                            {entry.marketPaused ? "PAUSED" : "NOT PAUSED"}
                          </State>
                        </Field>
                      )}
                    </Fields>
                  </Card>
                );
              })}
            </div>
          )}
        </Section>
      )}

      <Section title="WHAT A CERTIFICATE CANNOT DO">
        <div
          style={{
            display: "grid",
            gap: "var(--spacing-24)",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
          }}
        >
          {[
            [
              "Call anything else",
              "The instruction discriminator and target program are fixed at arm time. A certificate naming a different one is refused by the adapter, not by policy.",
            ],
            [
              "Reach another account",
              "The account list is committed as a template. Substituting any single account, even one belonging to another armed protocol in the same covenant, is refused.",
            ],
            [
              "Act twice",
              "The adapter's receipt, the target protocol's own last-operation stamp, and the settlement receipt each refuse a repeat independently.",
            ],
            [
              "Outlive a suspension",
              "A protocol that suspends after certification still refuses. The certificate does not become authority by existing first.",
            ],
          ].map(([title, body]) => (
            <Card key={title}>
              <h3 style={{ fontSize: "var(--text-subheading)", fontWeight: 400, marginTop: 0 }}>
                {title}
              </h3>
              <p
                style={{ color: "var(--color-steel)", margin: 0, fontSize: "var(--text-body-sm)" }}
              >
                {body}
              </p>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}

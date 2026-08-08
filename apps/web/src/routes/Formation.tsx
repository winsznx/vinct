/**
 * The covenant: who is in it, what they agreed to, and which signature did what.
 *
 * Formation is the part of VINCT nobody can do alone, so the page is arranged around that. Each
 * step names the key that had to sign it, and the two steps with no signer are marked as such,
 * because "permissionless" here is a design claim and not an omission: by the time a covenant
 * ratifies, every signature that mattered has already been given.
 */

import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { PublicKey } from "@solana/web3.js";
import { CovenantStatus, MemberRole } from "@vinct/client";

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
import { connect, findCovenantMembers, hex, shortAddress } from "../data/chain";
import { readEndpoints, recallCovenant, rememberCovenant } from "../data/config";
import { usePolled } from "../data/useChain";
import { decodeCovenant } from "@vinct/client";

export function Formation() {
  const location = useLocation();
  const navigate = useNavigate();
  const endpoints = readEndpoints(location.search);
  const params = new URLSearchParams(location.search);
  const covenantParam = params.get("covenant") ?? recallCovenant() ?? "";
  const [input, setInput] = useState(covenantParam);

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
    const account = await connection.getAccountInfo(covenant);
    if (!account) return null;
    return {
      covenant: decodeCovenant(account.data),
      members: await findCovenantMembers(connection, covenant),
    };
  }, [endpoints.base, covenant?.toBase58()]);

  return (
    <>
      <Eyebrow>Formed in advance, by everyone, one signature at a time</Eyebrow>
      <Stamp>FORMATION</Stamp>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = input.trim();
          try {
            new PublicKey(trimmed);
          } catch {
            return;
          }
          rememberCovenant(trimmed);
          const next = new URLSearchParams(location.search);
          next.set("covenant", trimmed);
          navigate({ pathname: "/formation", search: `?${next.toString()}` }, { replace: true });
        }}
        style={{
          display: "flex",
          gap: "var(--spacing-12)",
          flexWrap: "wrap",
          margin: "var(--spacing-32) 0 var(--spacing-64)",
          maxWidth: 820,
        }}
      >
        <label style={{ flex: "1 1 420px", display: "grid", gap: "var(--spacing-8)" }}>
          <span className="label">Covenant address</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            data-testid="covenant-input"
            placeholder="Paste a covenant address"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-body-sm)",
              background: "var(--surface-wash)",
              color: "var(--color-almost-white)",
              border: "1px solid var(--hairline)",
              borderRadius: "var(--radius-control)",
              padding: "12px 14px",
              width: "100%",
            }}
          />
        </label>
        <div style={{ display: "flex", alignItems: "end" }}>
          <Button type="submit" variant="filled" testId="load-covenant">
            Load
          </Button>
        </div>
      </form>

      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
      {state.status === "error" && <Problem kind="error" message={state.message} />}

      {state.status === "ready" && state.value === null && covenant && (
        <Empty>
          Nothing at <Address value={covenant.toBase58()} /> on{" "}
          <span className="mono">{endpoints.base}</span>. Either the address is wrong or this is the
          wrong cluster.
        </Empty>
      )}

      {!covenant && (
        <Empty>
          Paste a covenant address above. The local stack scripts print one, and every other page in
          this app follows whatever is selected here.
        </Empty>
      )}

      {state.status === "ready" && state.value && (
        <>
          <Section title="TERMS">
            <Card outlined>
              <div style={{ marginBottom: "var(--spacing-24)" }}>
                <State
                  tone={state.value.covenant.status === CovenantStatus.Armed ? "good" : "waiting"}
                >
                  {CovenantStatus[state.value.covenant.status].toUpperCase()}
                </State>
              </div>
              <Fields>
                <Field label="Threshold">
                  {state.value.covenant.requiredApprovals} of {state.value.covenant.memberCount}{" "}
                  must approve
                </Field>
                <Field label="Blocking rejections">
                  more than {state.value.covenant.maximumRejections} blocks certification
                </Field>
                <Field label="Response window" mono>
                  {state.value.covenant.responseWindowSlots.toString()} slots
                </Field>
                <Field label="Certificate lifetime" mono>
                  {state.value.covenant.certificateLifetimeSlots.toString()} slots
                </Field>
                <Field label="Epoch" mono>
                  {state.value.covenant.circleEpoch.toString()}
                </Field>
                <Field label="Frozen member set" mono>
                  {hex(state.value.covenant.memberSetHash).slice(0, 32)}…
                </Field>
              </Fields>
            </Card>
            <Empty>
              An incident opened under this covenant copies every one of these and can change none
              of them. The opener chooses nothing except when to open.
            </Empty>
          </Section>

          <Section title="MEMBERS">
            {state.value.members.length === 0 ? (
              <Empty>No memberships found for this covenant.</Empty>
            ) : (
              <div style={{ display: "grid", gap: "var(--spacing-16)" }} data-testid="member-list">
                {state.value.members.map(({ address, member }) => (
                  <div key={address.toBase58()}>
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
                      <span style={{ color: "var(--color-steel)", flex: "1 1 120px" }}>
                        {MemberRole[member.role]}
                      </span>
                      <State tone={member.ratified ? "good" : "waiting"}>
                        {member.ratified ? "RATIFIED" : "NOT RATIFIED"}
                      </State>
                      <State tone={member.armed ? "good" : "waiting"}>
                        {member.armed ? `ARMED v${member.adapterVersion}` : "NOT ARMED"}
                      </State>
                    </div>
                  </div>
                ))}
                <Rule />
              </div>
            )}
          </Section>
        </>
      )}

      <Section title="WHO SIGNS WHAT">
        <div
          style={{
            display: "grid",
            gap: "var(--spacing-24)",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
          }}
        >
          {[
            [
              "Convene",
              "The steward",
              "Creates the covenant and sets its terms. Can do nothing else, ever.",
            ],
            ["Add member", "The steward", "Names a protocol. Naming is not consent."],
            [
              "Ratify membership",
              "Each protocol",
              "Its own account, its own signature. Nobody can do this for anyone.",
            ],
            [
              "Ratify covenant",
              "Nobody",
              "Permissionless, because every signature that mattered is already collected. The member set is frozen here.",
            ],
            [
              "Arm membership",
              "Each protocol",
              "Commits its adapter version. Again, its own signature only.",
            ],
            [
              "Arm covenant",
              "Nobody",
              "Permissionless once every adapter-owning member has armed.",
            ],
          ].map(([step, signer, why]) => (
            <Card key={step as string}>
              <Eyebrow>{step}</Eyebrow>
              <div
                style={{
                  fontSize: "var(--text-subheading)",
                  fontWeight: 400,
                  margin: "var(--spacing-8) 0",
                  color: signer === "Nobody" ? "var(--color-steel)" : "var(--color-almost-white)",
                }}
              >
                {signer}
              </div>
              <p
                style={{ color: "var(--color-steel)", margin: 0, fontSize: "var(--text-body-sm)" }}
              >
                {why}
              </p>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}

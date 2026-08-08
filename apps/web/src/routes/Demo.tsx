/**
 * The judge path.
 *
 * Somebody with ten minutes and no wallet should leave understanding VINCT. That means no
 * addresses to paste, no covenant to create, no MagicBlock knowledge assumed, and no
 * documentation.
 *
 * Everything shown is from a run that happened. The addresses, signatures, receipts, and
 * classifications come from committed artifacts produced against Solana Devnet, and the page
 * says which run and when rather than implying it is live. That distinction is the honest one:
 * a replay of real evidence is stronger than a live demo that could be mocked, and weaker than
 * a live chain read, so it claims exactly what it is.
 *
 * The second scenario is the point. A judge who only sees the success case has watched a system
 * work; a judge who sees the stripped cohort understands why it is built this way.
 */

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { Mechanism, type MechanismPhase } from "../components/Mechanism";
import { Address, Card, Field, Fields, Pill, Section, Technical } from "../components/primitives";
import {
  EXPIRY_RUN,
  LIFECYCLE,
  RESPONSE_POLICY,
  SHARED_DEPENDENCY,
  STRIPPED_RUN,
  SUCCESS_RUN,
  type DemoRun,
} from "../lib/demo";
import { explorer, useNetwork } from "../lib/network";

export function Demo() {
  const location = useLocation();
  const network = useNetwork();
  const [step, setStep] = useState(0);
  const [run, setRun] = useState<DemoRun>(SUCCESS_RUN);

  const active = LIFECYCLE[step]!;
  // The diagram's five phases map onto the seven lifecycle steps: arming, opening, responding,
  // certifying, acting. The last three steps all sit at the final phase because they are the
  // same moment observed three ways.
  const phase = Math.min(4, [0, 1, 2, 3, 3, 4, 4][step] ?? 0) as MechanismPhase;

  return (
    <div className="wrap" style={{ padding: "var(--s7) var(--s5) var(--s9)" }}>
      <header className="stack" style={{ gap: "var(--s4)", marginBottom: "var(--s7)" }}>
        <div className="row" style={{ flexWrap: "wrap", gap: "var(--s2)" }}>
          <Pill tone="attention">Recorded on Solana Devnet</Pill>
          <Pill>{new Date(SUCCESS_RUN.capturedAt).toISOString().slice(0, 10)}</Pill>
        </div>
        <h1 className="m-heading" style={{ maxWidth: "20ch" }}>
          One incident, from agreement to verified settlement
        </h1>
        <p className="t-lead muted" style={{ maxWidth: "62ch" }}>
          Three lending protocols share a price feed. Walk through what happens when it fails. Every
          address, signature, and outcome below came from a run against Devnet, not from a fixture.
        </p>
      </header>

      {/* ------------------------------------------------------- the covenant */}
      <Section
        title="The covenant"
        description="Formed before anything is wrong. Nobody can form it alone."
      >
        <div className="grid-2">
          <Card>
            <div className="stack">
              <Fields>
                <Field label="Shared dependency">{SHARED_DEPENDENCY}</Field>
                <Field label="Members">3 protocols</Field>
                <Field label="Threshold">2 of 3, privately</Field>
                <Field label="Readiness">
                  <Pill tone="ok">3 of 3 armed</Pill>
                </Field>
              </Fields>
              <hr className="sep" />
              <div className="stack-sm">
                <div className="label">Response policy</div>
                <p className="t-body">{RESPONSE_POLICY}</p>
              </div>
            </div>
          </Card>

          <Card>
            <div className="stack">
              <div className="label">Members and what each authorised</div>
              {SUCCESS_RUN.adapters.map((adapter) => (
                <div key={adapter.address}>
                  <div className="row-between" style={{ gap: "var(--s3)" }}>
                    <div className="stack-sm" style={{ gap: 2 }}>
                      <span className="t-body" style={{ fontWeight: 500 }}>
                        {adapter.protocol}
                      </span>
                      <span className="t-small muted">Pause new borrowing on its own market</span>
                    </div>
                    <Pill tone="ok">Armed</Pill>
                  </div>
                  <hr className="sep" style={{ marginTop: "var(--s3)" }} />
                </div>
              ))}
              <p className="t-small muted">
                Each protocol armed its own adapter with its own key. VINCT holds no authority over
                any of them and cannot act on their behalf.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      {/* -------------------------------------------------------- the walk */}
      <Section title="What happened" description="Seven steps. Click through them.">
        <div
          style={{
            display: "grid",
            gap: "var(--s5)",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
            alignItems: "start",
          }}
        >
          <div className="stack" style={{ gap: "var(--s2)" }}>
            {LIFECYCLE.map((entry, index) => {
              const isActive = index === step;
              const isDone = index < step;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setStep(index)}
                  data-testid={`lifecycle-${entry.id}`}
                  className="card card-tight card-link"
                  style={{
                    textAlign: "left",
                    borderColor: isActive ? "var(--line-violet)" : undefined,
                    background: isActive ? "var(--panel-hover)" : undefined,
                  }}
                >
                  <div className="row" style={{ gap: "var(--s3)", alignItems: "flex-start" }}>
                    <span
                      className="mono"
                      style={{
                        color: isActive
                          ? "var(--violet)"
                          : isDone
                            ? "var(--text-muted)"
                            : "var(--text-dim)",
                        flex: "none",
                      }}
                    >
                      {entry.ordinal}
                    </span>
                    <div className="grow">
                      <div
                        className="t-base"
                        style={{ fontWeight: 500, color: isActive ? "var(--text)" : undefined }}
                      >
                        {entry.title}
                      </div>
                      <div className="t-small muted">{entry.summary}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="stack" style={{ gap: "var(--s4)", position: "sticky", top: 80 }}>
            <Mechanism phase={phase} animated={false} />
            <Card>
              <div className="stack-sm">
                <div className="label">
                  {active.ordinal} · {active.title}
                </div>
                <p className="t-body">{active.detail}</p>
              </div>
            </Card>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------------- the outcomes */}
      <Section
        title="Two incidents, same covenant"
        description="The second one is why VINCT is built this way."
      >
        <div className="row" style={{ gap: "var(--s2)", marginBottom: "var(--s4)" }}>
          <button
            type="button"
            className={`btn btn-sm ${run.id === "success" ? "btn-primary" : ""}`}
            onClick={() => setRun(SUCCESS_RUN)}
            data-testid="run-success"
          >
            Coordinated response
          </button>
          <button
            type="button"
            className={`btn btn-sm ${run.id === "stripped" ? "btn-primary" : ""}`}
            onClick={() => setRun(STRIPPED_RUN)}
            data-testid="run-stripped"
          >
            Nothing executed
          </button>
        </div>

        <Outcome run={run} network={network} search={location.search} />
      </Section>

      {/* ---------------------------------------------------------- expiry */}
      <Section
        title="And when nobody answers"
        description="An incident cannot stay open forever waiting for a quorum that is not coming."
      >
        <Card>
          <div className="stack">
            <Fields>
              <Field label="Outcome">
                <Pill tone="ok">{EXPIRY_RUN.incidentStatus}</Pill>
              </Field>
              <Field label="Settled by">MagicBlock scheduler, no person involved</Field>
              <Field label="Iterations before the deadline">
                {EXPIRY_RUN.iterations}, each a no-op
              </Field>
              <Field label="Private fields erased">
                {EXPIRY_RUN.scrubVerified ? "verified on base" : "not verified"}
              </Field>
            </Fields>
            <p className="t-base muted">
              A scheduled task ran repeatedly while the response window was open and did nothing
              each time, because the window was still open. The first iteration after the deadline
              settled the incident. The same instruction is permissionless, so if the scheduler
              disappeared entirely anyone could call it.
            </p>
          </div>
        </Card>
      </Section>

      <div className="row" style={{ flexWrap: "wrap", gap: "var(--s3)" }}>
        <Link
          to={{ pathname: `/proof/${run.operationId}`, search: location.search }}
          className="btn btn-signal"
          data-testid="demo-verify"
        >
          Verify this operation yourself
        </Link>
        <Link to={{ pathname: "/app", search: location.search }} className="btn">
          Open the application
        </Link>
      </div>
    </div>
  );
}

function Outcome({
  run,
  network,
  search,
}: {
  run: DemoRun;
  network: ReturnType<typeof useNetwork>;
  search: string;
}) {
  const settled = run.classification === "AllActionsApplied";
  const applied = run.adapters.filter((adapter) => adapter.applied).length;

  return (
    <div className="stack">
      <Card tone={settled ? undefined : "attention"}>
        <div className="stack">
          <div className="row-between">
            <div className="stack-sm">
              <Pill tone={settled ? "ok" : "attention"}>
                {settled ? "Settled" : "Commit without actions"}
              </Pill>
              <div className="t-title">{run.outcome}</div>
            </div>
            <div className="stack-sm" style={{ textAlign: "right" }}>
              <div className="label">Protocol actions observed</div>
              <div className="t-page" style={{ color: settled ? undefined : "var(--attention)" }}>
                {applied} of {run.adapters.length}
              </div>
            </div>
          </div>

          <hr className="sep" />

          <div className="stack-sm">
            {run.adapters.map((adapter) => (
              <div key={adapter.address} className="row-between" style={{ gap: "var(--s3)" }}>
                <span className="t-body">{adapter.protocol}</span>
                <Pill tone={adapter.applied ? "ok" : "waiting"}>
                  {adapter.applied ? "Paused new borrowing" : "No action"}
                </Pill>
              </div>
            ))}
          </div>

          <hr className="sep" />

          <p className="t-body muted">
            {settled
              ? "Each protocol's own adapter honoured the certificate, its target market changed, and the settlement receipt was written. Every one of those was read back off the base layer rather than inferred from the transaction that scheduled them."
              : "The scheduling transaction succeeded exactly as it did in the other incident. One protocol's adapter could not act, and one failing action removes every action in that transaction. Nothing partial happened, and VINCT does not report success. An automatic retry is blocked: recovery needs a fresh operation identity and human approval."}
          </p>

          <Fields>
            <Field label="Scheduling signature" mono>
              {network.isLocal ? (
                <span className="break">{run.schedulingSignature.slice(0, 22)}…</span>
              ) : (
                <a
                  href={explorer("tx", run.schedulingSignature, network) ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="break"
                >
                  {run.schedulingSignature.slice(0, 22)}…
                </a>
              )}
            </Field>
            <Field label="Means">Intent accepted, and nothing more</Field>
            <Field label="Private fields erased">
              {run.scrubVerified ? "verified on base" : "not verified"}
            </Field>
            <Field label="Recovery">{run.recoveryVerdict}</Field>
          </Fields>
        </div>
      </Card>

      <Technical label="Addresses and evidence from this run">
        <div className="stack">
          <Fields>
            <Field label="Covenant" mono>
              <Address value={run.covenant} full />
            </Field>
            <Field label="Incident" mono>
              <Address value={run.incident} full />
            </Field>
            <Field label="Operation" mono>
              <Address value={run.operationId} full />
            </Field>
            <Field label="Certificate" mono>
              <Address value={run.certificate} full />
            </Field>
          </Fields>
          <hr className="sep" />
          <div className="stack-sm">
            <div className="label">Independent verification</div>
            <p className="t-base muted">
              {run.checks.filter((check) => check.passed).length} of {run.checks.length} checks
              passed when this run was recorded. Re-run them against the chain now from{" "}
              <Link to={{ pathname: `/proof/${run.operationId}`, search }}>the proof page</Link>.
            </p>
          </div>
          <hr className="sep" />
          <div className="stack-sm">
            <div className="label">Endpoints</div>
            <span className="mono break">{run.endpoints.base}</span>
            <span className="mono break">{run.endpoints.er}</span>
            <p className="t-small muted">
              The base endpoint is redacted in the committed record, because a paid RPC carries its
              credential in the URL. The host and network survive.
            </p>
          </div>
        </div>
      </Technical>

      <p className="t-small muted">
        This is a recorded run replayed from a committed artifact, not a live chain read. The proof
        page reads the chain now. <Link to={{ pathname: "/status", search }}>Service status</Link>.
      </p>
    </div>
  );
}

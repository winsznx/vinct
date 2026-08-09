/**
 * Independent verification, as a product rather than a developer utility.
 *
 * No wallet, no login, and nothing about this page that has to be trusted. It reads the incident
 * and its covenant off the chain, re-derives the operation identity from the covenant's own
 * frozen terms with an implementation that shares no code with the on-chain program, and then
 * checks that every account involved carries that identity.
 *
 * Verification and delivery are shown apart, and that separation is the page's most important
 * piece of honesty. Whether an operation is the honest derivation of terms the members agreed
 * to, and whether the cohort then landed, are different questions. A cohort that was scheduled
 * and stripped has correctly bound receipts and no effects at all, so folding the two together
 * would let a verified identity read as a completed settlement. An earlier version of the
 * verifier did exactly that. See docs/decision-log.md D-0058.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { Connection } from "@solana/web3.js";
import {
  adapterReceiptAddress,
  certificateAddress,
  decodeCertificate,
  incidentAddress,
  settlementReceiptAddress,
} from "@vinct/client";
import { verifyOperation, type OperationVerification } from "@vinct/verifier";

import { SiteChrome } from "../components/SiteChrome";
import {
  Address,
  Card,
  Field,
  Fields,
  Loading,
  Pill,
  Problem,
  Section,
  Technical,
} from "../components/primitives";
import { findCapabilities } from "../data/chain";
import { PROTOCOL_NAMES, STRIPPED_RUN, SUCCESS_RUN } from "../lib/demo";
import { explorer, useNetwork } from "../lib/network";

export function Proof() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const network = useNetwork();
  const search = new URLSearchParams(location.search);

  const carried = params.operationId ?? search.get("operation") ?? "";
  const [input, setInput] = useState(carried);
  const [result, setResult] = useState<OperationVerification | null>(null);
  const [problem, setProblem] = useState<{ kind: "unreachable" | "error"; message: string } | null>(
    null,
  );
  const [running, setRunning] = useState(false);

  const operationId = useMemo(() => parseOperation(input), [input]);

  useEffect(() => {
    const target = parseOperation(carried);
    if (target) void run(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried, network.base]);

  async function run(id: Uint8Array): Promise<void> {
    setRunning(true);
    setProblem(null);
    setResult(null);
    try {
      const connection = new Connection(network.base, "confirmed");
      // The adapter lookup is a program scan, which not every endpoint serves. See Network.scan.
      const scanner =
        network.scan === network.base ? connection : new Connection(network.scan, "confirmed");
      const certificateAccount = await connection.getAccountInfo(certificateAddress(id));
      if (!certificateAccount) {
        setProblem({
          kind: "error",
          message: `No certificate exists for that operation on ${network.label}. Either it never certified, or this is the wrong cluster.`,
        });
        return;
      }
      const certificate = decodeCertificate(certificateAccount.data);
      const core = incidentAddress(certificate.covenant, certificate.incidentId);
      const capabilities = await findCapabilities(scanner, certificate.covenant);

      setResult(
        await verifyOperation(connection, {
          incidentCore: core,
          certificate: certificateAddress(id),
          settlementReceipt: settlementReceiptAddress(id),
          adapterReceipts: capabilities.map((entry, index) => ({
            label: Object.values(PROTOCOL_NAMES)[index] ?? `Adapter ${index + 1}`,
            address: adapterReceiptAddress(id, entry.address),
          })),
        }),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setProblem({
        kind: /fetch|NetworkError/i.test(message) ? "unreachable" : "error",
        message,
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <SiteChrome>
      <div className="wrap page-offset" style={{ padding: "var(--s7) var(--s5) var(--s9)" }}>
        <header className="stack" style={{ gap: "var(--s3)", marginBottom: "var(--s6)" }}>
          <Pill>No wallet · No login · Nothing here to trust</Pill>
          <h1 className="m-heading" style={{ maxWidth: "18ch" }}>
            Check a settlement yourself
          </h1>
          <p className="t-lead muted" style={{ maxWidth: "60ch" }}>
            Paste an operation ID. This reads the incident and its covenant from {network.label} and
            re-derives the operation identity from the covenant&rsquo;s frozen terms, using an
            implementation that shares no code with the on-chain program. If the two disagree,
            nothing else matters.
          </p>
        </header>

        <form
          className="form-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!operationId) return;
            navigate({ pathname: `/proof/${input.trim()}`, search: location.search });
          }}
        >
          <label>
            <span className="label">Operation ID · 64 hex characters</span>
            <input
              className="field"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="7e63e0e7ed31e69dd9dd9cc6d93c9e455f71a0ad…"
              data-testid="operation-input"
            />
          </label>
          <div>
            <button
              type="submit"
              className="btn btn-signal"
              disabled={!operationId || running}
              data-testid="verify"
            >
              {running ? "Reading the chain…" : "Verify"}
            </button>
          </div>
        </form>

        {!carried && !result && !problem && (
          <Section title="Or try one of these" description="Both are real operations from Devnet.">
            <div className="grid-2">
              <SampleCard
                title="A coordinated response"
                body="Three protocols paused new borrowing. Three receipts, three target effects, one settlement receipt."
                operation={SUCCESS_RUN.operationId}
                search={location.search}
                tone="ok"
              />
              <SampleCard
                title="Scheduling accepted, nothing executed"
                body="The same transaction succeeded and no protocol acted. This is the one worth checking."
                operation={STRIPPED_RUN.operationId}
                search={location.search}
                tone="attention"
              />
            </div>
          </Section>
        )}

        {running && <Loading rows={4} />}
        {problem && <Problem kind={problem.kind} message={problem.message} />}

        {result && (
          <>
            <Section title="Verification">
              <Card tone={result.verified ? undefined : "attention"}>
                <div className="stack">
                  <div className="row-between">
                    <Pill tone={result.verified ? "ok" : "blocked"}>
                      {result.verified
                        ? `Verified · ${result.checks.length} checks`
                        : "Not verified"}
                    </Pill>
                    <span className="t-small muted">read from {network.label}</span>
                  </div>
                  <hr className="sep" />
                  <Fields>
                    <Field label="Recorded by the program" mono>
                      {result.operationId}
                    </Field>
                    <Field label="Derived here, independently" mono>
                      {result.derivedOperationId}
                    </Field>
                  </Fields>
                </div>
              </Card>

              <Card className="card-flush">
                <div className="scroll-x">
                  <table className="table" data-testid="checks">
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Result</th>
                        <th>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.checks.map((check) => (
                        <tr key={check.name}>
                          <td data-label="Check">{check.name}</td>
                          <td data-label="Result">
                            <Pill tone={check.passed ? "ok" : "blocked"}>
                              {check.passed ? "Pass" : "Fail"}
                            </Pill>
                          </td>
                          <td data-label="Value">
                            <span className="mono dim break">{check.detail}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </Section>

            <Section
              title="Delivery"
              description="Reported, and deliberately not part of the verdict above."
            >
              <Card>
                <div className="stack">
                  <p className="t-body muted" style={{ maxWidth: "68ch" }}>
                    Verification establishes that an operation identity is the honest derivation of
                    terms the members agreed to. Whether the cohort then landed is a different
                    question. A cohort that was scheduled and stripped has correctly bound receipts
                    and no effects at all, so folding these together would let a verified identity
                    read as a completed settlement.
                  </p>
                  <hr className="sep" />
                  <Fields>
                    <Field label="Settlement receipt">
                      <Pill tone={result.delivery.settlementFinalized ? "ok" : "waiting"}>
                        {result.delivery.settlementFinalized ? "Finalized" : "Not finalized"}
                      </Pill>
                    </Field>
                    {result.delivery.adapters.map((adapter) => (
                      <Field key={adapter.label} label={adapter.label}>
                        <Pill
                          tone={adapter.executed && adapter.targetEffectApplied ? "ok" : "waiting"}
                        >
                          {adapter.executed && adapter.targetEffectApplied
                            ? "Applied"
                            : adapter.executed
                              ? "Receipt without effect"
                              : "No action"}
                        </Pill>
                      </Field>
                    ))}
                  </Fields>
                </div>
              </Card>
            </Section>

            <Technical label="Run the same verification from a terminal">
              <pre className="mono scroll-x" style={{ margin: 0, lineHeight: 1.8 }}>
                {`pnpm verify-operation artifacts/devnet/phase5-composition-success.json
pnpm verify-vectors`}
              </pre>
              <p className="t-small muted" style={{ marginTop: "var(--s3)" }}>
                It reads the addresses from a run artifact and trusts none of its claims.
              </p>
            </Technical>
          </>
        )}
      </div>
    </SiteChrome>
  );
}

function SampleCard({
  title,
  body,
  operation,
  search,
  tone,
}: {
  title: string;
  body: string;
  operation: string;
  search: string;
  tone: "ok" | "attention";
}) {
  return (
    <Card tone={tone === "attention" ? "attention" : undefined}>
      <div className="stack">
        <Pill tone={tone}>{tone === "ok" ? "Settled" : "Commit without actions"}</Pill>
        <div className="t-lead" style={{ fontWeight: 500 }}>
          {title}
        </div>
        <p className="t-base muted">{body}</p>
        <Link to={{ pathname: `/proof/${operation}`, search }} className="btn btn-sm">
          Verify this one
        </Link>
      </div>
    </Card>
  );
}

/** Accepts hex with or without a `0x` prefix, and nothing else. */
export function parseOperation(input: string): Uint8Array | null {
  const cleaned = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export { Address, explorer };

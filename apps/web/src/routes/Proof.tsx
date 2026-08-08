/**
 * The proof path. Two minutes, no wallet, no login, no trust in this page.
 *
 * Paste an operation ID, or arrive on a link that carries one. The page reads the incident and
 * the covenant off the chain, re-derives the operation ID from the covenant's frozen terms with
 * `packages/verifier`, and shows every check separately. The verifier shares no code with the
 * program: that is the whole reason its agreement means something.
 *
 * Delivery is shown apart from verification, deliberately. Identity being correct and a cohort
 * having landed are different questions, and folding them together would let a verified
 * operation read as a completed settlement. A cohort that was scheduled and stripped has
 * correctly bound receipts and no effects. See docs/decision-log.md D-0058.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { PublicKey } from "@solana/web3.js";
import {
  adapterReceiptAddress,
  certificateAddress,
  incidentAddress,
  settlementReceiptAddress,
  decodeCertificate,
} from "@vinct/client";
import { verifyOperation, type OperationVerification } from "@vinct/verifier";

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
import { connect, findCapabilities, hex } from "../data/chain";
import { readEndpoints } from "../data/config";

export function Proof() {
  const location = useLocation();
  const navigate = useNavigate();
  const endpoints = readEndpoints(location.search);
  const params = new URLSearchParams(location.search);

  const [operationInput, setOperationInput] = useState(params.get("operation") ?? "");
  const [result, setResult] = useState<OperationVerification | null>(null);
  const [problem, setProblem] = useState<{ kind: "unreachable" | "error"; message: string } | null>(
    null,
  );
  const [running, setRunning] = useState(false);

  const operationId = useMemo(() => parseOperation(operationInput), [operationInput]);

  // A deep link that carries an operation verifies without anyone pressing anything. That is
  // the two-minute path: open the link, read the checks.
  useEffect(() => {
    const carried = params.get("operation");
    if (carried && parseOperation(carried)) void run(parseOperation(carried)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  async function run(id: Uint8Array): Promise<void> {
    setRunning(true);
    setProblem(null);
    setResult(null);
    try {
      const connection = connect(endpoints.base);

      // The incident is found from the certificate, not supplied. A page that let somebody name
      // the incident would be verifying the pair they chose rather than the one the chain says.
      const certificateAccount = await connection.getAccountInfo(certificateAddress(id));
      if (!certificateAccount) {
        setProblem({
          kind: "error",
          message: `No certificate exists for operation ${hex(id)} on ${endpoints.base}. Either this operation never certified, or this is the wrong cluster.`,
        });
        return;
      }
      const certificate = decodeCertificate(certificateAccount.data);
      const core = incidentAddress(certificate.covenant, certificate.incidentId);

      const capabilities = await findCapabilities(connection, certificate.covenant);
      const verification = await verifyOperation(connection, {
        incidentCore: core,
        certificate: certificateAddress(id),
        settlementReceipt: settlementReceiptAddress(id),
        // The receipt's address, derived from the operation and the capability. Passing the
        // capability itself here was a real bug, and the decoder's discriminator check is what
        // caught it: reading a capability as a receipt failed loudly instead of returning a
        // plausible wrong answer. See docs/decision-log.md D-0052.
        adapterReceipts: capabilities.map((entry, index) => ({
          label: `adapter ${index + 1}`,
          address: adapterReceiptAddress(id, entry.address),
        })),
      });
      setResult(verification);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unreachable = message.includes("fetch") || message.includes("NetworkError");
      setProblem({ kind: unreachable ? "unreachable" : "error", message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Eyebrow>No wallet. No login. No trust in this page.</Eyebrow>
      <Stamp id="proof-heading">PROOF</Stamp>
      <p
        style={{
          maxWidth: 720,
          marginTop: "var(--spacing-24)",
          color: "var(--color-almost-white)",
        }}
      >
        Paste an operation ID. This page reads the incident and its covenant from the chain and
        re-derives the operation ID from the covenant&rsquo;s frozen terms, using an implementation
        that shares no code with the on-chain program. If the two disagree, nothing else matters.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!operationId) return;
          const next = new URLSearchParams(location.search);
          next.set("operation", operationInput.trim());
          navigate({ pathname: "/proof", search: `?${next.toString()}` }, { replace: true });
        }}
        className="form-row"
      >
        <label>
          <span className="label">Operation ID (64 hex characters)</span>
          <input
            value={operationInput}
            onChange={(event) => setOperationInput(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            data-testid="operation-input"
            placeholder="597e1c096aac45b2…"
          />
        </label>
        <div>
          <Button type="submit" variant="filled" disabled={!operationId || running} testId="verify">
            {running ? "Reading the chain…" : "Verify"}
          </Button>
        </div>
      </form>

      {problem && <Problem kind={problem.kind} message={problem.message} />}

      {result && (
        <>
          <Section title="VERIFICATION" id="verification">
            <Card outlined>
              <Fields>
                <Field label="Recorded by the program" mono>
                  {result.operationId}
                </Field>
                <Field label="Derived here, independently" mono>
                  {result.derivedOperationId}
                </Field>
              </Fields>
              <div style={{ marginTop: "var(--spacing-32)" }}>
                <State tone={result.verified ? "good" : "blocked"}>
                  {result.verified ? `VERIFIED — ${result.checks.length} checks` : "NOT VERIFIED"}
                </State>
              </div>
            </Card>

            <ul
              data-testid="checks"
              style={{ listStyle: "none", padding: 0, margin: 0, display: "grid" }}
            >
              {result.checks.map((check) => (
                <li key={check.name}>
                  <Rule />
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--spacing-16)",
                      alignItems: "baseline",
                      padding: "var(--spacing-16) 0",
                      flexWrap: "wrap",
                    }}
                  >
                    <State tone={check.passed ? "good" : "blocked"}>
                      {check.passed ? "PASS" : "FAIL"}
                    </State>
                    <span style={{ flex: "1 1 320px" }}>{check.name}</span>
                    <span
                      className="mono"
                      style={{ color: "var(--color-graphite)", overflowWrap: "anywhere" }}
                    >
                      {check.detail}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="DELIVERY">
            <Empty>
              Reported, not verified. Verification is about whether an operation ID is the honest
              derivation of terms the members agreed to. Whether the cohort then landed is a
              separate question, and a cohort that was scheduled and stripped has correctly bound
              receipts and no effects at all.
            </Empty>
            <Card outlined>
              <Fields>
                <Field label="Settlement receipt">
                  <State tone={result.delivery.settlementFinalized ? "good" : "waiting"}>
                    {result.delivery.settlementFinalized ? "FINALIZED" : "NOT FINALIZED"}
                  </State>
                </Field>
                {result.delivery.adapters.map((adapter) => (
                  <Field key={adapter.label} label={adapter.label}>
                    <State
                      tone={adapter.executed && adapter.targetEffectApplied ? "good" : "waiting"}
                    >
                      {adapter.executed && adapter.targetEffectApplied
                        ? "APPLIED"
                        : adapter.executed
                          ? "RECEIPT WITHOUT EFFECT"
                          : "NOT APPLIED"}
                    </State>
                  </Field>
                ))}
              </Fields>
            </Card>
          </Section>
        </>
      )}

      {!result && !problem && (
        <Section title="RUN IT YOURSELF">
          <Empty>
            The same verification runs from a terminal against any cluster, reading only the
            addresses in a run artifact and trusting none of its claims.
          </Empty>
          <Card outlined>
            <pre
              className="mono"
              style={{
                margin: 0,
                overflowX: "auto",
                color: "var(--color-almost-white)",
                lineHeight: 1.7,
              }}
            >
              {`pnpm verify-operation artifacts/local-stack/phase5-composition-success.json
pnpm verify-vectors`}
            </pre>
          </Card>
        </Section>
      )}
    </>
  );
}

/** Accepts hex with or without a 0x prefix, and nothing else. */
function parseOperation(input: string): Uint8Array | null {
  const cleaned = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export { parseOperation };
export type { PublicKey };
export { Address };

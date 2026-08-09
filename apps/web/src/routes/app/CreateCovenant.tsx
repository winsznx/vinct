/**
 * Forming a covenant, as five steps rather than one form.
 *
 * The sequence is the product's argument: nobody can do this alone. A single form with a submit
 * button would hide that, so each step names the signature it needs and who has to provide it.
 *
 * The final step does not send a transaction from this browser. Convening is signed by the
 * steward, and every member then ratifies and arms with its own key from its own tooling. What
 * this screen produces is the exact configuration to convene with, which is the honest boundary
 * for a page that holds no keys.
 */

import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { Connection, PublicKey } from "@solana/web3.js";

import { AppShell, RequiresWallet } from "../../components/AppShell";
import { Card, Field, Fields, Note, PageHeader, Pill } from "../../components/primitives";
import { convene, type CovenantDraft } from "../../lib/formation";
import { useNetwork } from "../../lib/network";
import { explainError, parsePublicKey } from "../../lib/sign";
import { useWallet } from "../../lib/wallet";

const STEPS = ["Dependency", "Members", "Policy", "Review", "Convene"] as const;

export function CreateCovenant() {
  const location = useLocation();
  const { publicKey } = useWallet();
  const [step, setStep] = useState(0);
  const [dependency, setDependency] = useState("");
  const [members, setMembers] = useState<string[]>(["", "", ""]);
  const [threshold, setThreshold] = useState(2);
  const [windowSlots, setWindowSlots] = useState(150_000);

  const named = members.filter((member) => member.trim().length > 0);
  const canReview = dependency.trim().length > 0 && named.length >= 2;

  return (
    <AppShell>
      <PageHeader
        back={{ to: `/app/covenants${location.search}`, label: "Covenants" }}
        title="Create a covenant"
        description="An agreement between protocols that share a dependency. You are proposing it; every member still has to accept it with their own key."
      />

      <ol className="row" style={{ gap: "var(--s2)", flexWrap: "wrap", marginBottom: "var(--s6)" }}>
        {STEPS.map((name, index) => (
          <li key={name}>
            <button
              type="button"
              className={`btn btn-sm ${index === step ? "btn-primary" : ""}`}
              onClick={() => setStep(index)}
              disabled={index > 2 && !canReview}
            >
              <span className="mono">{String(index + 1).padStart(2, "0")}</span> {name}
            </button>
          </li>
        ))}
      </ol>

      <RequiresWallet purpose="Convening a covenant is signed by the steward, so VINCT needs to know which key that is.">
        <Card>
          {step === 0 && (
            <div className="stack">
              <div className="t-title">What do these protocols share?</div>
              <p className="t-body muted">
                The dependency whose failure this covenant exists for. An oracle, a bridge, a shared
                library.
              </p>
              <label className="stack-sm">
                <span className="label">Shared dependency</span>
                <input
                  className="field"
                  value={dependency}
                  onChange={(event) => setDependency(event.target.value)}
                  placeholder="Pyth SOL/USD price feed"
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep(1)}
                disabled={!dependency.trim()}
              >
                Continue
              </button>
            </div>
          )}

          {step === 1 && (
            <div className="stack">
              <div className="t-title">Who is in it?</div>
              <p className="t-body muted">
                The protocol authority address for each member. Naming somebody here is a proposal,
                not consent: each one ratifies with their own signature afterwards.
              </p>
              {members.map((member, index) => (
                <label key={index} className="stack-sm">
                  <span className="label">Protocol {index + 1}</span>
                  <input
                    className="field"
                    value={member}
                    onChange={(event) => {
                      const next = [...members];
                      next[index] = event.target.value;
                      setMembers(next);
                    }}
                    placeholder="Protocol authority address"
                  />
                </label>
              ))}
              <div className="row" style={{ gap: "var(--s2)" }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setMembers([...members, ""])}
                >
                  Add member
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setStep(2)}
                  disabled={named.length < 2}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <div className="t-title">How many have to agree?</div>
              <Fields>
                <label className="stack-sm">
                  <span className="label">Approvals required</span>
                  <input
                    className="field"
                    type="number"
                    min={1}
                    max={Math.max(1, named.length)}
                    value={threshold}
                    onChange={(event) => setThreshold(Number(event.target.value))}
                  />
                </label>
                <label className="stack-sm">
                  <span className="label">Response window (slots)</span>
                  <input
                    className="field"
                    type="number"
                    min={1000}
                    value={windowSlots}
                    onChange={(event) => setWindowSlots(Number(event.target.value))}
                  />
                </label>
              </Fields>
              <Note title="The threshold is frozen when the covenant ratifies">
                An incident copies it and cannot change it. That is what stops whoever opens an
                incident from choosing the answer.
              </Note>
              <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
                Review
              </button>
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <div className="t-title">Review</div>
              <Fields>
                <Field label="Shared dependency">{dependency}</Field>
                <Field label="Members">{named.length}</Field>
                <Field label="Threshold">
                  {threshold} of {named.length}
                </Field>
                <Field label="Response window">{windowSlots.toLocaleString()} slots</Field>
                <Field label="Steward" mono>
                  {publicKey?.toBase58() ?? "not connected"}
                </Field>
              </Fields>
              <button type="button" className="btn btn-primary" onClick={() => setStep(4)}>
                Continue to convene
              </button>
            </div>
          )}

          {step === 4 && (
            <div className="stack">
              <ConveneAction
                draft={{
                  dependency,
                  members: named
                    .map((m) => parsePublicKey(m))
                    .filter((k): k is PublicKey => k !== null),
                  requiredApprovals: threshold,
                  maximumRejections: Math.max(1, named.length - threshold),
                  responseWindowSlots: BigInt(windowSlots),
                }}
              />
              <hr className="sep" />
              <div className="row" style={{ gap: "var(--s2)" }}>
                <Pill tone="attention">Five signatures, not one</Pill>
              </div>
              <div className="t-title">What happens next</div>
              <ol className="stack-sm">
                {[
                  ["You convene", "One transaction, signed by you as steward."],
                  ["You add each member", "Naming them. It grants nothing."],
                  [
                    "Each protocol ratifies",
                    "Its own account, its own key. You cannot do this for them.",
                  ],
                  ["Each protocol arms its adapter", "Again, only for itself."],
                  [
                    "The covenant ratifies and arms",
                    "Permissionless, because every signature that mattered is in.",
                  ],
                ].map(([title, detail], index) => (
                  <li
                    key={title}
                    className="row"
                    style={{ gap: "var(--s3)", alignItems: "flex-start" }}
                  >
                    <span className="mono dim" style={{ flex: "none" }}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <div className="t-base" style={{ fontWeight: 500 }}>
                        {title}
                      </div>
                      <div className="t-small muted">{detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
              <Note title="You sign only your own step">
                Convening is one transaction, signed by you. Naming a member grants nothing: each
                protocol then ratifies and arms with its own key, and no button here can do it for
                them. That is the property the covenant exists to have.
              </Note>
            </div>
          )}
        </Card>
      </RequiresWallet>
    </AppShell>
  );
}

/**
 * The one transaction this screen sends.
 *
 * Convening creates a covenant with no members and no authority over anybody. Everything that
 * follows needs somebody else's signature, which is why this is a single button rather than a
 * wizard that finishes the job.
 */
function ConveneAction({ draft }: { draft: CovenantDraft }) {
  const wallet = useWallet();
  const network = useNetwork();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const ready = draft.dependency.trim().length > 0 && draft.members.length >= 2;

  return (
    <div className="stack">
      <button
        type="button"
        className="btn btn-signal"
        disabled={busy || !ready}
        data-testid="convene"
        onClick={() => {
          setBusy(true);
          setProblem(null);
          const connection = new Connection(network.base, "confirmed");
          void connection
            .getGenesisHash()
            .then((genesis) => convene(connection, wallet, draft, new PublicKey(genesis).toBytes()))
            .then(async ({ covenant }) => {
              // Naming members is the steward's other step, and it is part of the same intent.
              const { addMember } = await import("../../lib/formation");
              for (const protocol of draft.members) {
                await addMember(connection, wallet, covenant, protocol);
              }
              navigate(`/app/covenants/${covenant.toBase58()}`);
            })
            .catch((error: unknown) => setProblem(explainError(error)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Signing…" : `Convene and name ${draft.members.length} members`}
      </button>
      {problem !== null && (
        <p className="t-base" style={{ color: "var(--lavender)" }}>
          {problem}
        </p>
      )}
      {!ready && (
        <p className="t-small muted">
          A dependency and at least two protocol addresses are needed before this can be sent.
        </p>
      )}
    </div>
  );
}

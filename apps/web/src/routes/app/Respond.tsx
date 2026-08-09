/**
 * A member answering an incident, for real.
 *
 * This is the one screen where the browser touches private material, so it is the one screen
 * where the rules matter most.
 *
 * The wallet signs a challenge and the rollup issues a short-lived session. The key never
 * leaves the wallet, the token never leaves memory, and neither is written anywhere. What the
 * member then reads is only what their own permission allows: the claim, because they are in
 * the member set, and their own ballot, because it is theirs.
 *
 * Three things this component must never render, and the reason each one is a leak:
 *
 *   a live approval count, because knowing two of three have approved is a tradeable fact;
 *   which members have responded, because that is the same fact in a different shape;
 *   any other member's answer, which is the property the product is built around.
 *
 * It cannot render them by accident either. It never fetches another member's ballot account,
 * so there is nothing in scope to leak even if the markup were wrong.
 *
 * Writing is gated on runtime freshness. A rollup serving a cached executable would accept a
 * signature for logic nobody deployed, so a stale verdict disables submission rather than
 * warning about it.
 */

import { useCallback, useEffect, useState } from "react";

import { Decision, attestationAddress, claimAddress, submitSealedAttestation } from "@vinct/client";
import type { PublicKey } from "@solana/web3.js";

import { Card, Note, Pill, Sealed } from "../../components/primitives";
import { authenticateWallet, explainError, sendWithWallet } from "../../lib/sign";
import {
  describeRuntime,
  permitsWrites,
  resolveRuntime,
  type RuntimeVerdict,
} from "../../lib/runtime";
import type { Network } from "../../lib/network";
import { useWallet } from "../../lib/wallet";

type Phase =
  | { step: "idle" }
  | { step: "authenticating" }
  | { step: "ready"; claim: string; alreadyAnswered: boolean }
  | { step: "submitting"; decision: Decision }
  | { step: "sealed"; signature: string }
  | { step: "failed"; message: string };

export function Respond({
  network,
  incident,
  members,
}: {
  network: Network;
  incident: PublicKey;
  members: PublicKey[];
}) {
  const wallet = useWallet();
  const [runtime, setRuntime] = useState<RuntimeVerdict | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });

  // Freshness is checked before anything is offered, not after a signature is requested.
  useEffect(() => {
    if (!wallet.publicKey) return;
    let alive = true;
    void resolveRuntime(network, wallet.publicKey).then((verdict) => {
      if (alive) setRuntime(verdict);
    });
    return () => {
      alive = false;
    };
  }, [network, wallet.publicKey]);

  const open = useCallback(async () => {
    if (!wallet.publicKey || !permitsWrites(runtime)) return;
    setPhase({ step: "authenticating" });
    try {
      const session = await authenticateWallet(runtime.endpoint, wallet);

      // Only two accounts are ever fetched: the claim, which this member set may read, and this
      // member's own ballot. No other member's ballot address is even constructed.
      const [claimAccount, ownBallot] = await session.connection.getMultipleAccountsInfo([
        claimAddress(incident),
        attestationAddress(incident, wallet.publicKey),
      ]);

      if (!claimAccount) {
        setPhase({
          step: "failed",
          message:
            "The rollup did not return the claim for this session. Your permission may not include it.",
        });
        return;
      }

      // The member-scoped decoder, used only here and only on bytes the rollup handed to an
      // authenticated member. See its own comment for why it is separate.
      const { decodeIncidentClaimForMember, memberHasAnswered } = await import("@vinct/client");
      const claim = decodeIncidentClaimForMember(claimAccount.data);

      setPhase({
        step: "ready",
        claim: claim.claim.trim().length > 0 ? claim.claim : "(the opener left the claim empty)",
        alreadyAnswered: ownBallot ? memberHasAnswered(ownBallot.data) : false,
      });
    } catch (error) {
      setPhase({ step: "failed", message: explainError(error) });
    }
  }, [wallet, runtime, incident]);

  const submit = useCallback(
    async (decision: Decision) => {
      if (!wallet.publicKey || !permitsWrites(runtime)) return;
      setPhase({ step: "submitting", decision });
      try {
        const session = await authenticateWallet(runtime.endpoint, wallet);
        const signature = await sendWithWallet(
          session.connection,
          wallet,
          [
            submitSealedAttestation(
              incident,
              wallet.publicKey,
              decision,
              // A nonce the member has not used before. The slot is monotonic and public, and
              // it is not a secret: what it must not do is repeat.
              BigInt(await session.connection.getSlot()),
            ),
          ],
          // A rollup cannot always simulate its own permission checks, so preflight is skipped
          // and the result is read from the confirmed status instead.
          { skipPreflight: true },
        );
        setPhase({ step: "sealed", signature });
      } catch (error) {
        setPhase({ step: "failed", message: explainError(error) });
      }
    },
    [wallet, runtime, incident],
  );

  if (!wallet.publicKey) return null;

  const isMember = members.some((member) => member.equals(wallet.publicKey!));
  if (!isMember) {
    return (
      <Card>
        <div className="stack-sm">
          <Pill>Read-only</Pill>
          <p className="t-body muted">
            This wallet is not in this incident&rsquo;s member set, so there is no ballot for it to
            fill. The claim and every response are sealed from it.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card tone="attention" style={{ marginBottom: "var(--s6)" }}>
      <div className="stack">
        <div className="row-between">
          <div className="stack-sm">
            <div className="label">Your response</div>
            <div className="t-title">You represent a member of this covenant</div>
          </div>
          <Pill tone={phase.step === "sealed" ? "ok" : "attention"}>
            {phase.step === "sealed" ? "Sealed" : "Action required"}
          </Pill>
        </div>

        {runtime && !permitsWrites(runtime) && (
          <div className="card card-tight" style={{ background: "var(--raised)" }}>
            <div className="stack-sm">
              <Pill tone="blocked">
                {runtime.kind === "stale" ? "Rollup out of date" : "Runtime unverified"}
              </Pill>
              <p className="t-base muted">{describeRuntime(runtime)}</p>
            </div>
          </div>
        )}

        {phase.step === "idle" && (
          <>
            <p className="t-body muted">
              Reading the claim needs your wallet to sign a challenge so the rollup knows which key
              is asking. Nothing is spent and no transaction is sent by signing it.
            </p>
            <button
              type="button"
              className="btn btn-signal"
              onClick={() => void open()}
              disabled={!permitsWrites(runtime)}
              data-testid="respond-unlock"
            >
              {runtime === null ? "Checking the rollup…" : "Read the claim"}
            </button>
          </>
        )}

        {phase.step === "authenticating" && (
          <p className="t-body muted">Waiting for your wallet to sign the challenge…</p>
        )}

        {phase.step === "ready" && (
          <>
            <div className="stack-sm">
              <div className="label">The claim, visible to this member set only</div>
              <p className="t-body" style={{ whiteSpace: "pre-wrap" }}>
                {phase.claim}
              </p>
            </div>

            <hr className="sep" />

            {phase.alreadyAnswered ? (
              <div className="stack-sm">
                <Pill tone="ok">Already answered</Pill>
                <Sealed note="Your response is recorded. You cannot read it back, and neither can anyone else." />
              </div>
            ) : (
              <>
                <p className="t-body muted">
                  Your answer goes into an account only you can read. No other member learns what
                  you said, and you will not learn what they said.
                </p>
                <div className="row" style={{ flexWrap: "wrap", gap: "var(--s3)" }}>
                  <button
                    type="button"
                    className="btn btn-signal"
                    onClick={() => void submit(Decision.Approve)}
                    data-testid="respond-approve"
                  >
                    Approve response
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void submit(Decision.Reject)}
                    data-testid="respond-reject"
                  >
                    Decline
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {phase.step === "submitting" && (
          <p className="t-body muted">
            Waiting for your wallet, then for the rollup to confirm. Nothing is readable by another
            member at any point.
          </p>
        )}

        {phase.step === "sealed" && (
          <>
            <div className="t-title">Response sealed</div>
            <p className="t-body muted">
              Other members cannot read your decision. You cannot read theirs. The count appears
              only once the incident is over, and no account holds it before then.
            </p>
            <span className="mono dim break">{phase.signature}</span>
          </>
        )}

        {phase.step === "failed" && (
          <>
            <Pill tone="blocked">Not submitted</Pill>
            <p className="t-body muted">{phase.message}</p>
            <button type="button" className="btn btn-sm" onClick={() => setPhase({ step: "idle" })}>
              Try again
            </button>
          </>
        )}

        <Note title="Why this needs a signature and not a password">
          A private rollup will not answer an anonymous reader. Your wallet signs a challenge, the
          rollup issues a short-lived session, and the session lives in memory for this tab only.
          Your key never leaves your wallet, and nothing about your response is written to this
          browser.
        </Note>
      </div>
    </Card>
  );
}

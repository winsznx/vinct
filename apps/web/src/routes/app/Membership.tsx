/**
 * What this wallet may actually do, and the one button it may press.
 *
 * The rule: an action nobody can take is never rendered as though they could. A disabled button
 * for a permission the wallet does not hold teaches somebody the product is broken when it is
 * doing exactly what it promised, and an enabled one that fails in the wallet is worse.
 *
 * So each row asks a narrow question. Is this row the connected wallet, and is this the step it
 * is waiting for. Everything else is a status, not an affordance.
 */

import { useState } from "react";

import { Connection, PublicKey } from "@solana/web3.js";

import { Card, Pill } from "../../components/primitives";
import { armOwnAdapter, describeReadiness, ratifyOwnMembership } from "../../lib/formation";
import { useNetwork } from "../../lib/network";
import { explainError, parsePublicKey } from "../../lib/sign";
import type { CovenantSummary } from "../../lib/useCovenants";
import { describeRole, useWallet } from "../../lib/wallet";

/** The action for one readiness row, when the connected wallet is the one it waits for. */
export function MemberAction({
  covenant,
  protocol,
  ratified,
  armed,
}: {
  covenant: CovenantSummary;
  protocol: PublicKey;
  ratified: boolean;
  armed: boolean;
}) {
  const wallet = useWallet();
  const network = useNetwork();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [market, setMarket] = useState("");

  const isYou = wallet.publicKey?.equals(protocol) ?? false;
  if (!isYou) return <span className="t-small dim">—</span>;
  if (armed) return <span className="t-small muted">nothing outstanding</span>;

  const connection = (): Connection => new Connection(network.base, "confirmed");

  if (!ratified) {
    return (
      <div className="stack-sm">
        <button
          type="button"
          className="btn btn-sm btn-signal"
          disabled={busy}
          data-testid="ratify-own"
          onClick={() => {
            setBusy(true);
            setProblem(null);
            void ratifyOwnMembership(connection(), wallet, covenant.address)
              .catch((error: unknown) => setProblem(explainError(error)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Signing…" : "Ratify"}
        </button>
        {problem !== null && (
          <span className="t-small" style={{ color: "var(--lavender)" }}>
            {problem}
          </span>
        )}
      </div>
    );
  }

  // Arming binds the capability to one account this protocol already owns, so the address has to
  // come from the protocol rather than be guessed here.
  const target = parsePublicKey(market);
  return (
    <div className="stack-sm" style={{ minWidth: 220 }}>
      <input
        className="field"
        placeholder="Your market account address"
        value={market}
        onChange={(event) => setMarket(event.target.value)}
        spellCheck={false}
        data-testid="arm-target"
      />
      <button
        type="button"
        className="btn btn-sm btn-signal"
        disabled={busy || target === null}
        data-testid="arm-own"
        onClick={() => {
          if (!target) return;
          setBusy(true);
          setProblem(null);
          void connection()
            .getGenesisHash()
            .then(async (genesis) => {
              const slot = BigInt(await connection().getSlot());
              return armOwnAdapter(connection(), wallet, covenant.address, {
                protocolState: target,
                policyId: covenant.covenant.policyId,
                memberSetHash: covenant.covenant.memberSetHash,
                clusterGenesisHash: new PublicKey(genesis).toBytes(),
                validFromSlot: slot > 500n ? slot - 500n : 0n,
                expiresAtSlot: slot + 5_000_000n,
              });
            })
            .catch((error: unknown) => setProblem(explainError(error)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Signing…" : "Arm my adapter"}
      </button>
      <span className="t-small muted">
        One instruction, this account, pause only. Nothing else is ever permitted.
      </span>
      {problem !== null && (
        <span className="t-small" style={{ color: "var(--lavender)" }}>
          {problem}
        </span>
      )}
    </div>
  );
}

/**
 * What the connected wallet is, relative to this covenant.
 *
 * Five states with five different messages. An unrelated wallet is a different situation from a
 * disconnected one, and both differ from a member who owes a response, so collapsing them into
 * "connect your wallet" would send people to fix the wrong thing.
 */
export function RoleCard({ covenant }: { covenant: CovenantSummary }) {
  const wallet = useWallet();
  const rows = covenant.members.map((entry) => ({
    protocol: entry.member.protocol,
    ratified: entry.member.ratified,
    armed: entry.member.armed,
    isYou: wallet.publicKey?.equals(entry.member.protocol) ?? false,
  }));

  const mine = rows.find((row) => row.isYou);

  return (
    <Card>
      <div className="stack">
        <div className="row" style={{ gap: "var(--s2)", flexWrap: "wrap" }}>
          <Pill tone={covenant.role.kind === "unrelated" ? "waiting" : "attention"}>
            {describeRole(covenant.role)}
          </Pill>
          <span className="t-small muted">{describeReadiness(rows)}</span>
        </div>

        <p className="t-body muted">
          {covenant.role.kind === "disconnected" &&
            "Connect a wallet and VINCT will work out which protocol it represents. Reading never needs one."}
          {covenant.role.kind === "unrelated" &&
            "This wallet is not the steward and not a member of this covenant, so it has read-only access. Everything public about this covenant is visible; nothing private is."}
          {covenant.role.kind === "steward" &&
            "You convened this covenant. You may name members, and nothing else: each protocol ratifies and arms with its own key, and you cannot do it for them."}
          {covenant.role.kind === "member" &&
            mine !== undefined &&
            (mine.armed
              ? "Your adapter is armed. You can suspend it at any moment, including after a certificate has been issued, and the adapter will still refuse."
              : mine.ratified
                ? "You have ratified. Your adapter is not armed yet, so this covenant cannot open an incident."
                : "You have been named as a member and have not accepted. Nothing binds you until you ratify with your own key.")}
        </p>
      </div>
    </Card>
  );
}

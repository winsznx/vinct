/**
 * The operational console's frame.
 *
 * A rail on the left, a header carrying identity and network, content in the middle. Below the
 * breakpoint the rail becomes a scrolling strip rather than a hamburger, because the whole
 * navigation is five items and hiding five items behind a tap is a worse trade than showing them.
 *
 * The header answers "who am I and what am I looking at" without being asked, which is the
 * question the previous version of this app never answered anywhere.
 */

import { useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { Empty } from "./primitives";
import { Mark } from "./SiteChrome";
import { useNetwork } from "../lib/network";
import { useWallet } from "../lib/wallet";

const NAV = [
  { to: "/app", label: "Overview", end: true },
  { to: "/app/covenants", label: "Covenants" },
  { to: "/app/incidents", label: "Incidents" },
  { to: "/app/adapters", label: "Adapters" },
  { to: "/app/proof", label: "Proof" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const network = useNetwork();

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          background: "var(--frosted)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div
          className="wrap-app row-between"
          style={{ minHeight: "var(--header)", flexWrap: "nowrap", gap: "var(--s4)" }}
        >
          <Link
            to={{ pathname: "/", search: location.search }}
            className="row"
            style={{ gap: 10, flex: "none" }}
          >
            <Mark />
            <span style={{ fontWeight: 600, letterSpacing: "-0.01em" }}>VINCT</span>
          </Link>

          <div className="row" style={{ gap: "var(--s3)", flex: "none" }}>
            <Link
              to={{ pathname: "/status", search: location.search }}
              className="row t-small muted"
              style={{ gap: 6 }}
              title="Service status"
            >
              <span
                className="dot"
                style={{ color: network.isLocal ? "var(--steel)" : "var(--ok)" }}
                aria-hidden="true"
              />
              <span className="hide-sm">{network.label}</span>
            </Link>
            <WalletButton />
          </div>
        </div>
      </header>

      <div
        className="wrap-app"
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "var(--rail) minmax(0, 1fr)",
          gap: "var(--s6)",
          alignItems: "start",
          paddingTop: "var(--s5)",
          paddingBottom: "var(--s9)",
        }}
      >
        <nav className="app-rail">
          <ul className="stack-sm">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={{ pathname: item.to, search: location.search }}
                  end={item.end ?? false}
                  data-testid={`app-nav-${item.label.toLowerCase()}`}
                  className="app-rail-link"
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Connect, and say which wallet.
 *
 * Three states with three different messages. No wallet in the browser is a different problem
 * from a wallet that has not been connected, and both differ from being connected, so the
 * button never says "connect" to somebody who has nothing to connect with.
 */
export function WalletButton() {
  const { available, publicKey, walletName, connecting, connect, disconnect, error } = useWallet();
  const [open, setOpen] = useState(false);

  if (publicKey) {
    return (
      <div style={{ position: "relative" }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setOpen((value) => !value)}
          data-testid="wallet-connected"
        >
          <span className="dot" style={{ color: "var(--violet)" }} aria-hidden="true" />
          {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
        </button>
        {open && (
          <div
            className="card card-tight"
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 8px)",
              minWidth: 240,
              zIndex: 50,
            }}
          >
            <div className="stack-sm">
              <div className="label">{walletName ?? "Wallet"}</div>
              <span className="mono break">{publicKey.toBase58()}</span>
              <hr className="sep" />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setOpen(false);
                  void disconnect();
                }}
                data-testid="wallet-disconnect"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (available.length === 0) {
    return (
      <a
        className="btn btn-sm"
        href="https://phantom.app/"
        target="_blank"
        rel="noreferrer"
        data-testid="wallet-none"
        title="No Solana wallet found in this browser"
      >
        Get a wallet
      </a>
    );
  }

  if (available.length === 1) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => void connect(available[0]!.id)}
        disabled={connecting}
        data-testid="wallet-connect"
        title={error ?? undefined}
      >
        {connecting ? "Connecting…" : "Connect"}
      </button>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => setOpen((value) => !value)}
        data-testid="wallet-connect"
      >
        Connect
      </button>
      {open && (
        <div
          className="card card-tight"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            minWidth: 200,
            zIndex: 50,
          }}
        >
          <div className="stack-sm">
            {available.map((wallet) => (
              <button
                key={wallet.id}
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setOpen(false);
                  void connect(wallet.id);
                }}
              >
                {wallet.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The wall in front of anything that needs a signature.
 *
 * Reading never reaches this. It stands only in front of writes, and it says what connecting
 * would unlock rather than demanding it.
 */
export function RequiresWallet({ children, purpose }: { children: ReactNode; purpose: string }) {
  const { publicKey } = useWallet();
  if (publicKey) return <>{children}</>;
  return (
    <Empty title="Connect a wallet to continue" action={<WalletButton />} testId="requires-wallet">
      {purpose} Reading VINCT never needs a wallet, and nothing is signed until you approve it.
    </Empty>
  );
}

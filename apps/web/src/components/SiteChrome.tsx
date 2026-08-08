/**
 * The public frame: marketing header and footer.
 *
 * Separate from the application shell on purpose. A visitor and an operator want different
 * things from a header, and one header trying to serve both is how a product ends up with
 * navigation that names its own internals.
 */

import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { useNetwork } from "../lib/network";

const LINKS: { to: string; label: string; secondary?: boolean }[] = [
  { to: "/demo", label: "Live demo" },
  { to: "/proof", label: "Verify" },
  // Reachable from the footer and the application header, so dropping it on a phone costs
  // nothing and buys back the width the page was overflowing by.
  { to: "/status", label: "Status", secondary: true },
];

export function SiteChrome({ children }: { children: ReactNode }) {
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
          className="wrap row-between"
          style={{ minHeight: "var(--header)", flexWrap: "nowrap", gap: "var(--s4)" }}
        >
          <Link to="/" className="row" style={{ gap: 10, flex: "none" }}>
            <Mark />
            <span style={{ fontWeight: 600, letterSpacing: "-0.01em" }}>VINCT</span>
          </Link>

          <nav className="row" style={{ gap: "var(--s2)", flex: "none" }}>
            {LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={{ pathname: link.to, search: location.search }}
                data-testid={`site-nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
                className={`btn btn-ghost btn-sm ${link.secondary ? "site-nav-secondary" : ""}`}
                style={({ isActive }) => ({
                  color: isActive ? "var(--text)" : undefined,
                })}
              >
                {link.label}
              </NavLink>
            ))}
            <Link
              to={{ pathname: "/app", search: location.search }}
              className="btn btn-sm"
              data-testid="site-nav-open-app"
            >
              Open VINCT
            </Link>
          </nav>
        </div>
      </header>

      <main style={{ flex: 1 }}>{children}</main>

      <footer style={{ borderTop: "1px solid var(--line)", marginTop: "var(--s9)" }}>
        <div
          className="wrap row-between"
          style={{ padding: "var(--s5) var(--s5)", alignItems: "flex-start" }}
        >
          <div className="stack-sm">
            <div className="row" style={{ gap: 10 }}>
              <Mark />
              <span style={{ fontWeight: 600 }}>VINCT</span>
            </div>
            <p className="t-small muted" style={{ maxWidth: "42ch" }}>
              Binding mutual aid for protocols sharing critical infrastructure.
            </p>
          </div>

          <div className="row" style={{ gap: "var(--s6)", alignItems: "flex-start" }}>
            <div className="stack-sm">
              <div className="label">Product</div>
              <Link to="/demo" className="t-small muted">
                Live demo
              </Link>
              <Link to="/proof" className="t-small muted">
                Verify a settlement
              </Link>
              <Link to="/app" className="t-small muted">
                Open VINCT
              </Link>
            </div>
            <div className="stack-sm">
              <div className="label">Network</div>
              <span className="t-small muted">{network.label}</span>
              <Link to="/status" className="t-small muted">
                Service status
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * The mark: three sovereign nodes bound by one line.
 *
 * The whole product in nine elements, and it reads at 20px.
 */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 15h16" stroke="#af50ff" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="4" cy="15" r="2.6" fill="var(--canvas)" stroke="#f7f9fa" strokeWidth="1.4" />
      <circle cx="12" cy="15" r="2.6" fill="var(--canvas)" stroke="#f7f9fa" strokeWidth="1.4" />
      <circle cx="20" cy="15" r="2.6" fill="var(--canvas)" stroke="#f7f9fa" strokeWidth="1.4" />
      <path d="M12 12V6" stroke="#af50ff" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="5" r="2" fill="#af50ff" />
    </svg>
  );
}

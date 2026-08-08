/**
 * The frame: a frosted nav, the page, and a coordinate footer.
 *
 * The footer's signature in design.md is a live GPS coordinate. This one carries the network
 * and the base endpoint instead, because on a page about what did and did not happen on a
 * chain, the useful thing to sign the page with is which chain.
 */

import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { readEndpoints } from "../data/config";

const LINKS: { to: string; label: string; end: boolean }[] = [
  { to: "/", label: "Overview", end: true },
  { to: "/formation", label: "Formation", end: false },
  { to: "/adapters", label: "Adapters", end: false },
  { to: "/incident", label: "Incident room", end: false },
  { to: "/observer", label: "Observer", end: false },
  { to: "/settlement", label: "Settlement", end: false },
  { to: "/proof", label: "Proof", end: false },
  { to: "/status", label: "Status", end: false },
];

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const endpoints = readEndpoints(location.search);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav className="nav">
        <div
          className="page"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-24)",
            minHeight: 64,
            flexWrap: "wrap",
          }}
        >
          <NavLink
            to={{ pathname: "/", search: location.search }}
            style={{ fontWeight: 500, letterSpacing: "-0.01em", fontSize: 18 }}
          >
            VINCT
          </NavLink>
          <ul
            style={{
              display: "flex",
              gap: "var(--spacing-20)",
              listStyle: "none",
              margin: 0,
              padding: 0,
              flexWrap: "wrap",
            }}
          >
            {LINKS.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={{ pathname: link.to, search: location.search }}
                  end={link.end}
                  data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
                  style={({ isActive }) => ({
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    color: isActive ? "var(--color-almost-white)" : "var(--color-steel)",
                  })}
                >
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <main className="page" style={{ flex: 1, paddingTop: "var(--spacing-64)" }}>
        {children}
      </main>

      <footer
        style={{
          borderTop: "1px solid var(--hairline-faint)",
          marginTop: "var(--spacing-96)",
        }}
      >
        <div
          className="page"
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "var(--spacing-24)",
            padding: "var(--spacing-32) var(--spacing-24)",
            flexWrap: "wrap",
            fontSize: "var(--text-body-sm)",
            color: "var(--color-steel)",
          }}
        >
          <span>
            <span style={{ color: "var(--color-almost-white)" }}>+</span> Binding mutual aid for
            protocols
          </span>
          <span className="mono" data-testid="footer-network">
            {endpoints.label} · {endpoints.base}
          </span>
        </div>
      </footer>
    </div>
  );
}

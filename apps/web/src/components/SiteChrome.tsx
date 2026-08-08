/**
 * The public frame: marketing header and footer.
 *
 * The header is a three-zone bar, which is the composition the reference navigation uses and
 * the one `design.md` describes: brand left, links centred, one action right. A flat row of
 * text links reads as a documentation site; the centred group with a single pill on the end
 * reads as a product.
 *
 * Two menus carry chevrons because they hold more than one destination. They are real
 * disclosure widgets rather than hover-only popovers: a hover menu is unreachable by keyboard,
 * unusable on a touch screen, and impossible to read with a screen reader. These open on click,
 * close on Escape or an outside click, and move focus properly.
 *
 * Nav type follows the spec: 12px uppercase at 0.07em, quiet enough to recede into the bar.
 *
 * Separate from the application shell on purpose. A visitor and an operator want different
 * things from a header, and one header trying to serve both is how a product ends up with
 * navigation named after its own internals.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { useNetwork } from "../lib/network";

interface MenuItem {
  to: string;
  label: string;
  hint: string;
}

/**
 * The two grouped menus.
 *
 * Every destination is a real page or a real section of this one. A menu that opens onto a
 * placeholder is worse than no menu.
 */
const PRODUCT: MenuItem[] = [
  { to: "/demo", label: "Live demo", hint: "A real incident, recorded on Devnet" },
  { to: "/app", label: "Open the console", hint: "Covenants, incidents, adapters" },
  { to: "/status", label: "Service status", hint: "What breaks when a service is down" },
];

const MECHANISM: MenuItem[] = [
  { to: "/#why", label: "Why this exists", hint: "The problem nobody can solve alone" },
  { to: "/#sovereignty", label: "What you keep", hint: "One action, not a relationship" },
  { to: "/#sealed", label: "Sealed quorum", hint: "Private from every other member" },
  { to: "/#failure", label: "When it fails", hint: "Commit without actions" },
];

export function SiteChrome({ children }: { children: ReactNode }) {
  const location = useLocation();
  const network = useNetwork();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header className="site-header">
        <div className="wrap site-bar">
          <Link
            to={{ pathname: "/", search: location.search }}
            className="row"
            style={{ gap: 10, flex: "none" }}
          >
            <Mark />
            <span style={{ fontWeight: 500, letterSpacing: "-0.01em" }}>VINCT</span>
          </Link>

          {/* The centre zone. Its own grid cell, so it stays centred on the bar rather than
              drifting with the width of the brand or the action beside it. */}
          <nav className="site-links" aria-label="Main">
            <Menu label="Product" items={PRODUCT} search={location.search} />
            <Menu label="How it works" items={MECHANISM} search={location.search} />
            <NavLink
              to={{ pathname: "/proof", search: location.search }}
              className="nav-link"
              data-testid="site-nav-verify"
            >
              Verify
            </NavLink>
          </nav>

          <div className="row site-actions" style={{ gap: "var(--s2)", flex: "none" }}>
            <Link
              to={{ pathname: "/status", search: location.search }}
              className="nav-link nav-link-status"
              title="Service status"
            >
              <span
                className="dot"
                style={{ color: network.isLocal ? "var(--steel)" : "var(--ok)" }}
                aria-hidden="true"
              />
              {network.label}
            </Link>
            <Link
              to={{ pathname: "/app", search: location.search }}
              className="btn btn-pill"
              data-testid="site-nav-open-app"
            >
              Open VINCT
              <Arrow />
            </Link>
            <button
              type="button"
              className="btn btn-sm site-menu-toggle"
              aria-expanded={mobileOpen}
              aria-controls="site-mobile-menu"
              onClick={() => setMobileOpen((open) => !open)}
              data-testid="site-menu-toggle"
            >
              {mobileOpen ? "Close" : "Menu"}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="site-mobile" id="site-mobile-menu">
            <div className="wrap" style={{ display: "grid", gap: "var(--s5)" }}>
              <MobileGroup title="Product" items={PRODUCT} search={location.search} />
              <MobileGroup title="How it works" items={MECHANISM} search={location.search} />
              <Link
                to={{ pathname: "/proof", search: location.search }}
                className="t-lead"
                style={{ fontWeight: 500 }}
              >
                Verify a settlement
              </Link>
            </div>
          </div>
        )}
      </header>

      <main style={{ flex: 1 }}>{children}</main>

      <footer style={{ borderTop: "1px solid var(--line)", marginTop: "var(--s9)" }}>
        <div
          className="wrap row-between"
          style={{ padding: "var(--s6) var(--s5)", alignItems: "flex-start" }}
        >
          <div className="stack-sm">
            <div className="row" style={{ gap: 10 }}>
              <Mark />
              <span style={{ fontWeight: 500 }}>VINCT</span>
            </div>
            <p className="t-small muted" style={{ maxWidth: "42ch" }}>
              Binding mutual aid for protocols sharing critical infrastructure.
            </p>
          </div>

          <div className="row" style={{ gap: "var(--s7)", alignItems: "flex-start" }}>
            <div className="stack-sm">
              <div className="label">Product</div>
              {PRODUCT.map((item) => (
                <Link key={item.to} to={item.to} className="t-small muted">
                  {item.label}
                </Link>
              ))}
            </div>
            <div className="stack-sm">
              <div className="label">Verify</div>
              <Link to="/proof" className="t-small muted">
                Check a settlement
              </Link>
              <Link to="/demo" className="t-small muted">
                Recorded evidence
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
 * A nav item that opens a panel.
 *
 * Click rather than hover. A hover menu cannot be opened from a keyboard, cannot be opened at
 * all on a touch screen, and gives a screen reader nothing to announce, so it fails three
 * audiences to save one interaction.
 */
function Menu({ label, items, search }: { label: string; items: MenuItem[]; search: string }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={container} style={{ position: "relative" }}>
      <button
        type="button"
        className="nav-link"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        data-testid={`site-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        {label}
        <Chevron open={open} />
      </button>

      {open && (
        <div className="nav-menu" id={id} role="group" aria-label={label}>
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to.startsWith("/#") ? item.to : { pathname: item.to, search }}
              className="nav-menu-item"
              onClick={() => setOpen(false)}
            >
              <span className="t-base" style={{ fontWeight: 500 }}>
                {item.label}
              </span>
              <span className="t-small muted">{item.hint}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function MobileGroup({
  title,
  items,
  search,
}: {
  title: string;
  items: MenuItem[];
  search: string;
}) {
  return (
    <div className="stack-sm">
      <div className="label">{title}</div>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to.startsWith("/#") ? item.to : { pathname: item.to, search }}
          className="t-body"
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(180deg)" : undefined,
        transition: "transform 140ms ease",
      }}
    >
      <path
        d="M2.5 4.5 6 8l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Arrow() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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

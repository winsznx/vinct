/**
 * An address that is not a route.
 *
 * There is nothing to "unlock" here. Every surface in this app reads public chain state, and the
 * one genuinely private thing, a member's ballot, is protected by the rollup's permission model
 * rather than by which URL somebody typed. So this page says that plainly instead of implying a
 * login would help.
 */

import { Link, useLocation } from "react-router-dom";

import { Button, Empty, Eyebrow, Stamp } from "../components/ui";

export function NotFound() {
  const location = useLocation();
  return (
    <div data-testid="not-found">
      <Eyebrow>No route</Eyebrow>
      <Stamp>NOT FOUND</Stamp>
      <div style={{ marginTop: "var(--spacing-24)", display: "grid", gap: "var(--spacing-24)" }}>
        <Empty>
          <span className="mono">{location.pathname}</span> is not a page. Nothing is being
          withheld: every surface here reads public chain state, and the one private thing, a
          member&rsquo;s ballot, is protected by the rollup&rsquo;s permission model rather than by
          a URL.
        </Empty>
        <div>
          <Link to={{ pathname: "/", search: location.search }}>
            <Button variant="filled" testId="not-found-home">
              Back to the overview
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

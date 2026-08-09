/**
 * An address that is not a route.
 *
 * Nothing is being withheld here, and the page says so rather than implying a login would help.
 * Every public surface reads chain state, and the one genuinely private thing, a member's
 * answer, is protected by the rollup's permission model rather than by which URL somebody typed.
 */

import { Link, useLocation } from "react-router-dom";

import { SiteChrome } from "../components/SiteChrome";
import { Empty } from "../components/primitives";

export function NotFound() {
  const location = useLocation();
  return (
    <SiteChrome>
      <div
        className="wrap page-offset"
        style={{ paddingInline: "var(--s5)", paddingBottom: "var(--s9)" }}
      >
        <Empty
          title="No page at that address"
          testId="not-found"
          action={
            <>
              <Link
                to={{ pathname: "/", search: location.search }}
                className="btn btn-primary btn-sm"
              >
                Back to the start
              </Link>
              <Link to={{ pathname: "/demo", search: location.search }} className="btn btn-sm">
                Explore the demo
              </Link>
            </>
          }
        >
          <span className="mono">{location.pathname}</span> is not a page. Nothing is being
          withheld: every public surface here reads chain state, and the one private thing, a
          member&rsquo;s answer, is protected by the rollup rather than by a URL.
        </Empty>
      </div>
    </SiteChrome>
  );
}

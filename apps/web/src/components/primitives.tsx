/**
 * The pieces every screen is built from.
 *
 * Two of these carry most of the product's meaning and are worth reading before the rest.
 *
 * `Sealed` is a value the viewer is not entitled to read. It is deliberately not an empty
 * state: nothing is missing, the value exists, and this viewer is not one of the people it was
 * written for. An interface that showed a blank there would be telling somebody the data is
 * absent, when the whole point is that it is present and protected.
 *
 * `Empty` always takes an action. A screen that says "nothing here" and stops is a dead end,
 * and dead ends are most of why the previous version of this app was unusable.
 */

import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";

export type Tone = "ok" | "waiting" | "attention" | "blocked";

const TONE_CLASS: Record<Tone, string> = {
  ok: "pill-ok",
  waiting: "pill-waiting",
  attention: "pill-attention",
  blocked: "pill-blocked",
};

/** A state, said in words with a dot beside it. The dot is never the only signal. */
export function Pill({
  tone = "waiting",
  children,
  title,
}: {
  tone?: Tone | undefined;
  children: ReactNode;
  title?: string | undefined;
}) {
  return (
    <span className={`pill ${TONE_CLASS[tone]}`} title={title}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  tone,
  style,
}: {
  children: ReactNode;
  className?: string;
  /** `undefined` is allowed so a caller can pass a conditional without a ternary at the tag. */
  tone?: "attention" | undefined;
  style?: CSSProperties | undefined;
}) {
  return (
    <div
      className={`card ${tone === "attention" ? "card-attention" : ""} ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

/** A card that is a link. Kept separate so a non-interactive card never gets hover affordance. */
export function CardLink({
  to,
  children,
  className = "",
  testId,
}: {
  to: string;
  children: ReactNode;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  return (
    <Link to={to} className={`card card-link ${className}`} data-testid={testId}>
      {children}
    </Link>
  );
}

/** One number and what it counts. The application's headline unit. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
  tone?: Tone | undefined;
}) {
  return (
    <div className="stack-sm">
      <div className="label">{label}</div>
      <div
        className="t-page"
        style={{ color: tone === "attention" ? "var(--attention)" : undefined }}
      >
        {value}
      </div>
      {hint !== undefined && <div className="t-small muted">{hint}</div>}
    </div>
  );
}

/** A label above its value. The workhorse of every detail panel. */
export function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean | undefined;
}) {
  return (
    <div className="stack-sm" style={{ minWidth: 0 }}>
      <div className="label">{label}</div>
      <div className={mono ? "mono break" : "t-body break"}>{children}</div>
    </div>
  );
}

export function Fields({
  children,
  columns,
}: {
  children: ReactNode;
  columns?: number | undefined;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--s5)",
        gridTemplateColumns: `repeat(${columns ? `auto-fit, minmax(min(180px, 100%), 1fr)` : `auto-fit, minmax(min(200px, 100%), 1fr)`})`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * A value this viewer is not entitled to read.
 *
 * Distinct from empty on purpose. Nothing is missing: the value exists inside the rollup, it is
 * readable by exactly one member, and this viewer is not that member. Rendering a blank would
 * say the opposite of what is true, and the privacy property is the product.
 */
export function Sealed({ note }: { note?: string | undefined }) {
  return (
    <div className="stack-sm">
      <span
        className="row"
        style={{ gap: 6, color: "var(--lavender)", fontSize: "var(--t-base)", fontWeight: 500 }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="10" width="16" height="11" rx="3" fill="currentColor" />
          <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2.6" />
        </svg>
        Sealed
      </span>
      {note !== undefined && <span className="t-small muted">{note}</span>}
    </div>
  );
}

/**
 * Nothing here, and the thing to do about it.
 *
 * The action is required rather than optional. An empty state without one is where people leave.
 */
export function Empty({
  title,
  children,
  action,
  testId,
}: {
  title: string;
  children?: ReactNode | undefined;
  action: ReactNode;
  testId?: string | undefined;
}) {
  return (
    <div
      className="card"
      data-testid={testId ?? "empty"}
      style={{ display: "grid", gap: "var(--s4)", justifyItems: "start", maxWidth: 620 }}
    >
      <div className="t-title">{title}</div>
      {children !== undefined && <p className="t-body muted">{children}</p>}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {action}
      </div>
    </div>
  );
}

/**
 * Something went wrong, and which kind.
 *
 * Three kinds, three messages. An unreachable node, a node that answered with an error, and a
 * node that declined a query it does not serve are different problems that send someone to fix
 * different things, and collapsing them wastes the reader's time.
 */
export function Problem({
  kind,
  message,
  action,
}: {
  kind: "unreachable" | "error" | "unsupported";
  message: string;
  action?: ReactNode | undefined;
}) {
  const heading =
    kind === "unreachable"
      ? "Cannot reach the network"
      : kind === "unsupported"
        ? "This node will not answer that"
        : "The read failed";
  const body =
    kind === "unreachable"
      ? "Nothing below is current. This is a connection problem rather than an empty result, and the page keeps retrying."
      : kind === "unsupported"
        ? "The node is up and declined the query this page needs, which is a property of the endpoint rather than of the chain. Nothing below is missing; it is unread."
        : "The node answered and the read failed, so nothing below is current.";

  return (
    <div
      className="card"
      data-testid={
        kind === "unreachable"
          ? "outage"
          : kind === "unsupported"
            ? "unsupported-rpc"
            : "read-error"
      }
      style={{ maxWidth: 680, display: "grid", gap: "var(--s3)", justifyItems: "start" }}
    >
      <Pill tone="blocked">{heading}</Pill>
      <p className="t-body muted">{body}</p>
      <p className="mono dim break">{message}</p>
      {action}
    </div>
  );
}

/** A short explanation attached to the thing a screen keeps having to justify. */
export function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card card-tight" style={{ background: "var(--raised)" }}>
      <div className="row" style={{ alignItems: "flex-start", gap: "var(--s3)" }}>
        <span className="pill" style={{ flex: "none" }}>
          Why
        </span>
        <div className="grow">
          <div className="t-base" style={{ fontWeight: 600 }}>
            {title}
          </div>
          <p className="t-base muted" style={{ marginTop: 4 }}>
            {children}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * An address, shortened, copyable, and expandable.
 *
 * Full addresses are noise in a dashboard and essential in evidence, so both are available and
 * the short form is the default.
 */
export function Address({ value, full }: { value: string; full?: boolean | undefined }) {
  const short = `${value.slice(0, 4)}…${value.slice(-4)}`;
  return (
    <button
      type="button"
      className="mono"
      title={`${value}\nClick to copy`}
      onClick={() => void navigator.clipboard?.writeText(value)}
      style={{ color: "inherit", textAlign: "left" }}
    >
      {full ? <span className="break">{value}</span> : short}
    </button>
  );
}

/**
 * Everything a reader does not need until they do.
 *
 * Hashes, program IDs, and commitments belong here rather than in the main surface. A protocol
 * operator deciding whether to arm an adapter is not reading a 32-byte digest, and a judge
 * checking the work needs it exactly.
 */
export function Technical({
  children,
  label = "Technical details",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <details className="card card-tight" style={{ background: "var(--raised)" }}>
      <summary
        className="label"
        style={{ cursor: "pointer", listStyle: "none", userSelect: "none" }}
      >
        {label}
      </summary>
      <div style={{ marginTop: "var(--s4)" }}>{children}</div>
    </details>
  );
}

/** The header every application route carries, so a title and its explanation never drift. */
export function PageHeader({
  title,
  description,
  action,
  badge,
  back,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode | undefined;
  badge?: ReactNode | undefined;
  back?: { to: string; label: string } | undefined;
}) {
  return (
    <header style={{ marginBottom: "var(--s5)" }}>
      {back && (
        <Link
          to={back.to}
          className="t-small muted"
          style={{ display: "inline-block", marginBottom: 8 }}
        >
          ← {back.label}
        </Link>
      )}
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <div className="row" style={{ gap: "var(--s3)" }}>
            <h1 className="t-page">{title}</h1>
            {badge}
          </div>
          {description !== undefined && (
            <p className="t-body muted" style={{ marginTop: 6, maxWidth: "68ch" }}>
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
    </header>
  );
}

export function Section({
  title,
  description,
  action,
  children,
  id,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode | undefined;
  children: ReactNode;
  id?: string | undefined;
}) {
  return (
    <section id={id} className="stack" style={{ marginBottom: "var(--s7)" }}>
      <div className="row-between" style={{ alignItems: "flex-end" }}>
        <div className="grow">
          <h2 className="t-title">{title}</h2>
          {description !== undefined && (
            <p className="t-base muted" style={{ marginTop: 4, maxWidth: "70ch" }}>
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A loading placeholder shaped like the thing it is waiting for. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: index === 0 ? 56 : 40 }} />
      ))}
    </div>
  );
}

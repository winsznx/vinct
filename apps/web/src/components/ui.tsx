/**
 * The components design.md describes, and only those.
 *
 * Stamped section headings, hairline dividers, cards with no fill, two button radii, and one
 * rationed violet. Every rule in the reference's Don't list is a rule this file follows: no
 * shadows, no violet borders or text, no third colour, no centred body copy.
 */

import type { CSSProperties, ReactNode } from "react";

export function Stamp({ children, id }: { children: string; id?: string }) {
  return (
    <h2 className="stamp" id={id}>
      {children}
    </h2>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

/**
 * A card with no fill and no border by default.
 *
 * "Let layout create the boundary, not a fill or border." The `outlined` variant adds the one
 * hairline the system allows, for cases where two cards sit side by side and the gap alone is
 * ambiguous.
 */
export function Card({
  children,
  outlined,
  style,
}: {
  children: ReactNode;
  outlined?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        borderRadius: "var(--radius-card)",
        padding: "var(--card-padding)",
        border: outlined ? "1px solid var(--hairline)" : "none",
        background: outlined ? "var(--surface-wash)" : "transparent",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The one violet fill a page is allowed. Used once, for the thing a judge should read first. */
export function BloomCard({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        borderRadius: "var(--radius-card)",
        padding: "var(--card-padding)",
        background:
          "radial-gradient(120% 140% at 15% 0%, var(--color-signal-violet) 0%, #4a1f6d 55%, #1a0d26 100%)",
        color: "var(--color-almost-white)",
      }}
    >
      {children}
    </div>
  );
}

export function Rule() {
  return <hr className="rule" />;
}

export function Button({
  children,
  onClick,
  variant = "outlined",
  disabled,
  type = "button",
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "filled" | "outlined" | "pill" | "quiet";
  disabled?: boolean;
  type?: "button" | "submit";
  testId?: string;
}) {
  const base: CSSProperties = {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-body)",
    fontWeight: 400,
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 120ms ease, border-color 120ms ease",
  };
  const variants: Record<string, CSSProperties> = {
    filled: {
      background: "var(--color-near-black)",
      border: "1px solid var(--color-almost-white)",
      borderRadius: "var(--radius-button)",
      padding: "var(--spacing-16)",
      color: "var(--color-almost-white)",
    },
    outlined: {
      background: "var(--surface-wash-strong)",
      border: "1px solid var(--hairline)",
      borderRadius: "var(--radius-control)",
      padding: "9px 15px",
      color: "var(--color-almost-white)",
      fontSize: "var(--text-body-sm)",
    },
    pill: {
      background: "var(--surface-wash)",
      border: "none",
      borderRadius: "var(--radius-pill)",
      padding: "var(--spacing-20) var(--spacing-32)",
      color: "var(--color-almost-white)",
    },
    quiet: {
      background: "transparent",
      border: "none",
      borderRadius: 0,
      padding: "10.4px 0",
      color: "var(--color-steel)",
      textDecoration: "underline",
      fontSize: "var(--text-body-sm)",
    },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={{ ...base, ...variants[variant] }}
    >
      {children}
    </button>
  );
}

export type Tone = "good" | "waiting" | "attention" | "blocked";

const TONE_COLOR: Record<Tone, string> = {
  good: "var(--state-good)",
  waiting: "var(--state-waiting)",
  attention: "var(--state-attention)",
  blocked: "var(--state-blocked)",
};

/**
 * A state, said in words with a dot beside it.
 *
 * The dot is never the only signal. A colour-blind reader, a screenshot in a report, and a
 * screen reader all get the same sentence, because the state is what the page is for.
 */
export function State({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--spacing-8)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-body-sm)",
        letterSpacing: "0.06em",
        color: TONE_COLOR[tone],
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: TONE_COLOR[tone],
          flexShrink: 0,
        }}
      />
      {children}
    </span>
  );
}

/** A label and a value, stacked. The workhorse of every detail panel here. */
export function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: "var(--spacing-4)", minWidth: 0 }}>
      <div className="label">{label}</div>
      <div
        style={{
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: mono ? "var(--text-body-sm)" : "var(--text-body)",
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Fields({ children, columns = 2 }: { children: ReactNode; columns?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--spacing-24)",
        gridTemplateColumns: `repeat(auto-fit, minmax(min(220px, 100%), 1fr))`,
        maxWidth: columns === 1 ? 640 : undefined,
      }}
    >
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p style={{ color: "var(--color-steel)", maxWidth: 620, margin: 0 }}>{children}</p>;
}

/**
 * What went wrong, and whether it was the network.
 *
 * The distinction is the same one the settlement monitor draws. A page that shows "nothing
 * found" when the RPC is down tells somebody an incident does not exist.
 */
export function Problem({
  kind,
  message,
}: {
  kind: "unreachable" | "error" | "unsupported";
  message: string;
}) {
  return (
    <div
      data-testid={
        kind === "unreachable"
          ? "outage"
          : kind === "unsupported"
            ? "unsupported-rpc"
            : "read-error"
      }
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: "var(--radius-card)",
        padding: "var(--spacing-24)",
        maxWidth: 640,
      }}
    >
      <State tone="blocked">{kind === "unreachable" ? "RPC UNREACHABLE" : "READ FAILED"}</State>
      <p style={{ color: "var(--color-steel)", marginBottom: 0 }}>
        {kind === "unreachable"
          ? "Nothing below is current. This is a connection problem, not an empty result, and the page will keep retrying."
          : kind === "unsupported"
            ? "The node is up and declined the query this page needs. That is a property of the endpoint, not of the chain, so nothing below is missing; it is unread."
            : "The node answered and the read failed. Nothing below is current."}
      </p>
      <p className="mono" style={{ color: "var(--color-graphite)", marginBottom: 0 }}>
        {message}
      </p>
    </div>
  );
}

export function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      style={{ display: "grid", gap: "var(--spacing-32)", marginBottom: "var(--spacing-96)" }}
    >
      <Stamp>{title}</Stamp>
      {children}
    </section>
  );
}

/** A monospaced address that stays selectable and never wraps mid-character. */
export function Address({ value }: { value: string }) {
  return (
    <span className="mono" style={{ overflowWrap: "anywhere", color: "var(--color-almost-white)" }}>
      {value}
    </span>
  );
}

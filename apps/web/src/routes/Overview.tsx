/**
 * The thirty seconds.
 *
 * The completion gate says a judge understands the result in under thirty seconds. So the first
 * screen is one sentence about what happened, one violet card carrying the outcome, and three
 * lines naming what makes it hard. Everything else on the page is below the fold and optional.
 *
 * The outcome card reads live state when a covenant is known and says so plainly when there is
 * nothing to read. It never shows a rehearsed result.
 */

import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";

import { IncidentStatus } from "@vinct/client";
import { PublicKey } from "@solana/web3.js";

import {
  BloomCard,
  Button,
  Card,
  Eyebrow,
  Field,
  Fields,
  Problem,
  Rule,
  Section,
  State,
} from "../components/ui";
import { connect, findIncidents, isTerminal, shortAddress } from "../data/chain";
import { readEndpoints, recallCovenant } from "../data/config";
import { usePolled } from "../data/useChain";

export function Overview() {
  const location = useLocation();
  const endpoints = readEndpoints(location.search);
  const covenantParam =
    new URLSearchParams(location.search).get("covenant") ?? recallCovenant() ?? null;

  const covenant = useMemo(() => {
    if (!covenantParam) return null;
    try {
      return new PublicKey(covenantParam);
    } catch {
      return null;
    }
  }, [covenantParam]);

  const { state } = usePolled(
    async () => (covenant ? findIncidents(connect(endpoints.base), covenant) : []),
    [endpoints.base, covenant?.toBase58()],
  );

  const latest =
    state.status === "ready" && state.value.length > 0 ? state.value[state.value.length - 1] : null;

  return (
    <>
      <section style={{ marginBottom: "var(--spacing-96)" }}>
        <Eyebrow>Solana · MagicBlock private ephemeral rollup</Eyebrow>
        <h1 className="display" style={{ marginTop: "var(--spacing-16)", maxWidth: 900 }}>
          Binding mutual aid
        </h1>
        <p
          style={{
            fontSize: "var(--text-subheading)",
            fontWeight: 300,
            maxWidth: 720,
            marginTop: "var(--spacing-24)",
            color: "var(--color-almost-white)",
          }}
        >
          Protocols sharing a critical dependency ratify a covenant in advance. When that dependency
          breaks, they certify the incident privately inside a rollup and each one&rsquo;s own
          bounded adapter acts. No protocol hands anyone else admin authority, and no one learns how
          a peer voted.
        </p>

        <div
          style={{
            display: "grid",
            gap: "var(--spacing-32)",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
            marginTop: "var(--spacing-48)",
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: "var(--spacing-24)" }}>
            <ThreeHardParts />
            <div style={{ display: "flex", gap: "var(--spacing-16)", flexWrap: "wrap" }}>
              <Link to={{ pathname: "/proof", search: location.search }}>
                <Button variant="filled" testId="cta-proof">
                  Verify a settlement yourself
                </Button>
              </Link>
              <Link to={{ pathname: "/observer", search: location.search }}>
                <Button variant="quiet">Watch an incident →</Button>
              </Link>
            </div>
          </div>

          <BloomCard>
            <Eyebrow>Latest incident</Eyebrow>
            {state.status === "unreachable" || state.status === "error" ? (
              <p style={{ marginBottom: 0 }}>
                No chain is reachable at <span className="mono">{endpoints.base}</span>. Nothing on
                this page is live.
              </p>
            ) : !covenant ? (
              <p style={{ marginBottom: 0 }} data-testid="no-covenant">
                No covenant selected. Open{" "}
                <Link
                  to={{ pathname: "/formation", search: location.search }}
                  style={{ textDecoration: "underline" }}
                >
                  Formation
                </Link>{" "}
                to point this at one, or run the local stack and the demo script.
              </p>
            ) : !latest ? (
              <p style={{ marginBottom: 0 }}>This covenant has opened no incidents yet.</p>
            ) : (
              <div
                style={{ display: "grid", gap: "var(--spacing-16)" }}
                data-testid="latest-incident"
              >
                <div style={{ fontSize: "var(--text-heading-sm)", lineHeight: 1.1 }}>
                  {headline(latest.core.status)}
                </div>
                <div style={{ opacity: 0.85 }}>
                  {latest.core.approvalCountAfterTerminal} of {latest.core.requiredApprovals}{" "}
                  approvals needed, counted inside the rollup. The individual ballots were never
                  visible to anyone, including each other.
                </div>
                <Link
                  to={{ pathname: "/observer", search: location.search }}
                  style={{ textDecoration: "underline" }}
                >
                  Incident {latest.core.incidentId.toString()} at {shortAddress(latest.address)} →
                </Link>
              </div>
            )}
          </BloomCard>
        </div>
      </section>

      <Section title="THE SEAM">
        <div
          style={{
            display: "grid",
            gap: "var(--spacing-40)",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
          }}
        >
          <Card>
            <Eyebrow>01 — Before</Eyebrow>
            <h3
              style={{
                fontSize: "var(--text-subheading)",
                fontWeight: 400,
                marginTop: "var(--spacing-12)",
              }}
            >
              Each protocol arms its own adapter
            </h3>
            <p style={{ color: "var(--color-steel)" }}>
              A capability commits to the shape and the limits of one action, not to a future
              incident. It is armed once, before any crisis, and the protocol can suspend it at any
              moment including after a certificate exists.
            </p>
          </Card>
          <Card>
            <Eyebrow>02 — During</Eyebrow>
            <h3
              style={{
                fontSize: "var(--text-subheading)",
                fontWeight: 400,
                marginTop: "var(--spacing-12)",
              }}
            >
              The vote happens where nobody can read it
            </h3>
            <p style={{ color: "var(--color-steel)" }}>
              Claim and ballots live in accounts each permissioned to one reader inside a private
              rollup. The program counts them in memory. No account ever holds a running tally, so
              there is none to leak.
            </p>
          </Card>
          <Card>
            <Eyebrow>03 — After</Eyebrow>
            <h3
              style={{
                fontSize: "var(--text-subheading)",
                fontWeight: 400,
                marginTop: "var(--spacing-12)",
              }}
            >
              Every effect is observed, never inferred
            </h3>
            <p style={{ color: "var(--color-steel)" }}>
              A scheduling signature means an intent was accepted and nothing more. Settlement is
              read back off the base layer, one effect at a time, and a cohort that half-applied
              blocks automated recovery outright.
            </p>
          </Card>
        </div>
      </Section>

      {state.status === "unreachable" && <Problem kind="unreachable" message={state.message} />}
    </>
  );
}

function ThreeHardParts() {
  return (
    <Card outlined>
      <Fields columns={1}>
        <Field label="What is private">
          Each member&rsquo;s ballot, from every other member. Not merely from the public.
        </Field>
        <Rule />
        <Field label="What is bounded">
          One instruction, one target, one effect ceiling, set by the protocol itself before the
          incident existed.
        </Field>
        <Rule />
        <Field label="What is proven">
          The operation ID re-derived from the covenant&rsquo;s own terms, by a verifier that shares
          no code with the program.
        </Field>
      </Fields>
    </Card>
  );
}

function headline(status: IncidentStatus): string {
  switch (status) {
    case IncidentStatus.CertifiedPendingSettlement:
      return "Certified. The threshold was met.";
    case IncidentStatus.Expired:
      return "Expired. Nobody answered in time.";
    case IncidentStatus.RejectedByThreshold:
      return "Rejected. The circle said no.";
    case IncidentStatus.Collecting:
      return "Collecting. The outcome is not knowable yet.";
    case IncidentStatus.Draft:
      return "Draft. Not yet open.";
    default:
      return "Aborted.";
  }
}

export function statusTone(status: IncidentStatus) {
  if (status === IncidentStatus.CertifiedPendingSettlement) return "attention" as const;
  if (isTerminal(status)) return "good" as const;
  return "waiting" as const;
}

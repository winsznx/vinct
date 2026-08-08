/**
 * The first fifteen seconds.
 *
 * One sentence about what VINCT does, one picture of the mechanism, and two places to go. No
 * covenant address, no jargon above the fold, and nothing a reader has to already know.
 *
 * The composition follows `design.md` at the scale it actually specifies, which the first pass
 * did not. An 88px display, a 74px stamped section label, and roughly 120px between bands. The
 * hero owns the viewport rather than sitting in a 1200px column with a third of a wide screen
 * empty on either side. Prose stays at a readable measure inside those wider bands, so the
 * generosity buys presence rather than long lines.
 *
 * Section order is the order a sceptical protocol engineer asks: why does this exist, what do I
 * give up, how does the private part work, what happens when it fails, and can I check any of
 * this myself. The last one is the only section that links into real evidence, and it is the one
 * that closes the argument.
 */

import { Link, useLocation } from "react-router-dom";

import { Mechanism } from "../components/Mechanism";
import { Card, Pill } from "../components/primitives";
import { STRIPPED_RUN, SUCCESS_RUN } from "../lib/demo";
import { useNetwork } from "../lib/network";

export function Landing() {
  const location = useLocation();
  const network = useNetwork();
  const search = location.search;

  return (
    <>
      {/* ------------------------------------------------------------ hero */}
      <section
        style={{
          // Owns the screen without trapping the reader: tall enough to be the only thing in
          // view, short enough that the next band's edge is visible on a laptop.
          minHeight: "min(88vh, 900px)",
          display: "flex",
          alignItems: "center",
          paddingTop: "var(--s8)",
          paddingBottom: "var(--s8)",
          background:
            "radial-gradient(70% 55% at 78% 42%, rgba(175, 80, 255, 0.10), transparent 70%)",
        }}
      >
        <div
          className="wrap-hero"
          style={{
            display: "grid",
            // design.md: roughly 55/45, text to card.
            gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)",
            gap: "var(--s8)",
            alignItems: "center",
          }}
        >
          <div style={{ display: "grid", gap: "var(--s5)", minWidth: 0 }}>
            <div>
              <Pill tone="attention">{network.label} · MagicBlock private rollup</Pill>
            </div>

            <h1 style={{ maxWidth: "12ch" }}>
              <span className="m-display">Coordinate</span>
              <br />
              <span className="m-heading" style={{ display: "inline-block", marginTop: "0.12em" }}>
                without sharing keys
              </span>
            </h1>

            <p className="m-lead" style={{ maxWidth: "46ch" }}>
              Protocols that depend on the same oracle or bridge can agree in advance on exactly
              what each will do in an emergency, decide privately whether it is happening, and act
              together. Nobody hands anybody else authority.
            </p>

            <div
              className="row"
              style={{ flexWrap: "wrap", gap: "var(--s3)", marginTop: "var(--s2)" }}
            >
              <Link
                to={{ pathname: "/demo", search }}
                className="btn btn-signal btn-lg"
                data-testid="cta-demo"
              >
                Explore live demo
              </Link>
              <Link to={{ pathname: "/app", search }} className="btn btn-lg" data-testid="cta-app">
                Open VINCT
              </Link>
            </div>

            <p className="t-small muted" style={{ maxWidth: "48ch" }}>
              The demo needs no wallet. It replays a real incident recorded on Devnet, with the
              addresses and signatures it produced.
            </p>
          </div>

          <Mechanism />
        </div>
      </section>

      {/* ------------------------------------------------------------- why */}
      <Band stamp="Why this exists">
        <Head
          title="Everyone finds out from Twitter"
          lead="Three lending protocols use the same price feed. It starts printing garbage. Each of them has a runbook, each acts alone, and the slowest one absorbs the damage. They could have agreed months earlier, and there was nothing to agree with."
        />
        <div className="grid-cards">
          <Point
            title="A multisig is the wrong shape"
            body="It asks every protocol to hand authority to a group. No serious protocol will, and they are right not to."
          />
          <Point
            title="A shared vote leaks"
            body="Any account holding a running tally can be read by whoever can touch it. Knowing that two of three have already approved is a tradeable fact."
          />
          <Point
            title="A scheduling receipt is not an outcome"
            body="Coordinated action across protocols usually reports success when the request was accepted, which is not the same as anything having happened."
          />
        </div>
      </Band>

      {/* ------------------------------------------------------- what you keep */}
      <Band stamp="Sovereignty" raised>
        <Head
          title="You authorise one action, not a relationship"
          lead="A capability is a bound you place on yourself, before any incident exists. It names one instruction, one account it may touch, one effect ceiling, and a window outside which nothing is accepted at all."
        />
        <div className="grid-2">
          <Card>
            <div className="stack">
              <div className="label">What a certificate can do</div>
              <p className="t-lead">
                Exactly one thing: the instruction you named, against the account you named, inside
                the limits you set.
              </p>
              <hr className="sep" />
              <div className="label">What it cannot do</div>
              <ul className="stack-sm t-body muted">
                <li>Call any other instruction, or reach any other account.</li>
                <li>Act twice. Three separate refusals stand in the way of a replay.</li>
                <li>Outlive your suspension, even if it was issued first.</li>
                <li>Exist at all without your covenant reaching its threshold.</li>
              </ul>
            </div>
          </Card>
          <Card>
            <div className="stack">
              <div className="label">Who signs what</div>
              {[
                ["Convene the covenant", "The steward, and nothing else ever"],
                ["Join it", "Each protocol, for itself only"],
                ["Arm an adapter", "Each protocol, for itself only"],
                ["Suspend an adapter", "Each protocol, at any moment"],
                ["Answer an incident", "Each member, once, privately"],
                ["Publish a certificate", "Nobody. The incident earns it"],
              ].map(([action, who]) => (
                <div key={action} className="row-between" style={{ gap: "var(--s4)" }}>
                  <span className="t-body">{action}</span>
                  <span className="t-body muted" style={{ textAlign: "right" }}>
                    {who}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Band>

      {/* ------------------------------------------------------------ private */}
      <Band stamp="Sealed quorum">
        <Head
          title="Your response is sealed from every other member"
          lead="Not merely from the public. Each member's answer lives in its own account inside a private rollup, readable by exactly one key. The program counts them in memory and never writes the count anywhere."
        />
        <div className="grid-cards">
          <Point
            title="No account holds a tally"
            body="There is nothing to leak, even to somebody who could read everything. The counts appear only once the incident is over."
          />
          <Point
            title="Silence costs nothing"
            body="A member who does not answer does not delay the outcome, and their silence is not visible either."
          />
          <Point
            title="Then it is erased"
            body="When the incident ends, the claim and every ballot are overwritten before the accounts leave the rollup, and the erasure is checked on the base layer."
          />
        </div>
      </Band>

      {/* ----------------------------------------------------------- failure */}
      <Band stamp="Commit without actions" raised>
        <Head
          title="VINCT will tell you nothing happened"
          lead="This is the part most coordination systems get wrong. A transaction that schedules emergency actions can succeed while every one of those actions is stripped and never runs."
        />
        <div className="grid-2">
          <Card>
            <div className="stack">
              <Pill tone="ok">Settled</Pill>
              <div className="t-title">All three protocols paused</div>
              <p className="t-body muted">
                Three adapter receipts, three target protocols changed, one settlement receipt. Each
                read back off the base layer rather than inferred.
              </p>
              <Link
                to={{ pathname: `/proof/${SUCCESS_RUN.operationId}`, search }}
                className="btn btn-sm"
              >
                Verify this one
              </Link>
            </div>
          </Card>
          <Card tone="attention">
            <div className="stack">
              <Pill tone="attention">Commit without actions</Pill>
              <div className="t-title">Scheduling succeeded. Nothing executed.</div>
              <p className="t-body muted">
                One protocol&rsquo;s adapter could not act, so none of them did. Zero markets
                paused, not two of three. VINCT reports that instead of reporting success, and
                blocks any automatic retry.
              </p>
              <Link
                to={{ pathname: `/proof/${STRIPPED_RUN.operationId}`, search }}
                className="btn btn-sm"
              >
                Verify this one too
              </Link>
            </div>
          </Card>
        </div>
      </Band>

      {/* -------------------------------------------------------------- proof */}
      <Band stamp="Check it yourself">
        <Head
          title="Nothing here asks you to trust this page"
          lead="Paste an operation ID and the verifier reads the incident and its covenant off the chain, re-derives the operation identity from the covenant's own frozen terms, and confirms every receipt carries it. It shares no code with the on-chain program, which is the only reason its agreement means anything."
        />
        <div className="row" style={{ flexWrap: "wrap", gap: "var(--s3)" }}>
          <Link to={{ pathname: "/demo", search }} className="btn btn-signal btn-lg">
            Walk through a real incident
          </Link>
          <Link to={{ pathname: "/proof", search }} className="btn btn-lg">
            Verify an operation
          </Link>
        </div>
      </Band>
    </>
  );
}

/**
 * One edge-to-edge band, signposted by its stamp.
 *
 * design.md puts the rhythm in the gap and the stamped label rather than in dividers, so there
 * is no rule between bands. The stamp is the thing a reader scrolls past and remembers.
 */
function Band({
  stamp,
  children,
  raised,
}: {
  stamp: string;
  children: React.ReactNode;
  raised?: boolean;
}) {
  return (
    <section className={`band ${raised ? "band-raised" : ""}`}>
      <div className="wrap" style={{ display: "grid", gap: "var(--s7)" }}>
        <h2 className="m-stamp">{stamp}</h2>
        {children}
      </div>
    </section>
  );
}

/**
 * A section heading and its lead.
 *
 * Each gets its own measure. `ch` resolves against the element's own font size, so one limit on
 * the container is set by the body font and then squeezes a 64px headline into a narrow column
 * with a stranded last line. The headline wants a couple of generous lines; the lead wants a
 * readable 60-odd characters.
 */
function Head({ title, lead }: { title: string; lead: string }) {
  return (
    <div style={{ display: "grid", gap: "var(--s4)" }}>
      <p className="m-heading" style={{ maxWidth: "17ch" }}>
        {title}
      </p>
      <p className="t-lead muted" style={{ maxWidth: "58ch" }}>
        {lead}
      </p>
    </div>
  );
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <div className="stack-sm">
        <div className="t-lead" style={{ fontWeight: 500 }}>
          {title}
        </div>
        <p className="t-body muted">{body}</p>
      </div>
    </Card>
  );
}

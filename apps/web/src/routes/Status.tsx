/**
 * Which services are up, and what stops working when one is not.
 *
 * A status page that only shows dots makes an outage look like a cosmetic problem. Each row here
 * says what the service is for and what degrades without it, because the useful question during
 * an outage is whether the thing you were about to do still works.
 *
 * The demo reset lives here too. It is a link to a script rather than a button: resetting is a
 * signed action against a local validator, and a web page that could do it would need an
 * authority nothing else in this design has.
 */

import { useLocation } from "react-router-dom";

import {
  Address,
  Card,
  Empty,
  Eyebrow,
  Field,
  Fields,
  Rule,
  Section,
  Stamp,
  State,
  type Tone,
} from "../components/ui";
import { readEndpoints } from "../data/config";
import { usePolled } from "../data/useChain";

interface ServiceState {
  name: string;
  endpoint: string;
  reachable: boolean;
  detail: string;
  purpose: string;
  degrades: string;
}

export function Status() {
  const location = useLocation();
  const endpoints = readEndpoints(location.search);

  const { state } = usePolled(
    async (): Promise<ServiceState[]> => {
      const services: ServiceState[] = [];

      services.push(
        await probe({
          name: "Base layer",
          endpoint: endpoints.base,
          method: "getHealth",
          purpose:
            "Covenants, capabilities, certificates, receipts, and every settled incident. The source of truth for anything this app claims.",
          degrades: "Everything. Nothing on any page is current without it.",
        }),
      );

      if (endpoints.ephemeral) {
        services.push(
          await probe({
            name: "Ephemeral rollup",
            endpoint: endpoints.ephemeral,
            method: "getHealth",
            purpose:
              "Where a live incident's private accounts sit, where ballots are submitted, and where the expiry crank runs.",
            degrades:
              "New incidents cannot be opened or answered. Settled incidents are unaffected: they already returned to base.",
          }),
        );
      }

      if (endpoints.router) {
        services.push(
          await probe({
            name: "Router",
            endpoint: endpoints.router,
            method: "getRoutes",
            purpose:
              "Resolves which rollup an account is delegated to. VINCT never hardcodes a regional endpoint.",
            degrades:
              "A live incident cannot be reached. The app refuses to guess an endpoint rather than sending private state to the wrong rollup.",
          }),
        );
      }

      return services;
    },
    [endpoints.base, endpoints.ephemeral, endpoints.router],
    10_000,
  );

  return (
    <>
      <Eyebrow>What is up, and what stops working when it is not</Eyebrow>
      <Stamp>STATUS</Stamp>

      <Section title="SERVICES">
        {state.status === "ready" ? (
          <div style={{ display: "grid" }} data-testid="service-list">
            {state.value.map((service) => (
              <div key={service.name}>
                <Rule />
                <div
                  style={{
                    display: "grid",
                    gap: "var(--spacing-12)",
                    padding: "var(--spacing-24) 0",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--spacing-24)",
                      flexWrap: "wrap",
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ fontSize: "var(--text-subheading)", flex: "1 1 200px" }}>
                      {service.name}
                    </span>
                    <State tone={service.reachable ? "good" : "blocked"}>
                      {service.reachable ? "REACHABLE" : "UNREACHABLE"}
                    </State>
                  </div>
                  <Address value={service.endpoint} />
                  <p style={{ color: "var(--color-steel)", margin: 0, maxWidth: 700 }}>
                    {service.purpose}
                  </p>
                  {!service.reachable && (
                    <p style={{ color: "var(--color-lavender-mist)", margin: 0, maxWidth: 700 }}>
                      {service.degrades}
                    </p>
                  )}
                  <span className="mono" style={{ color: "var(--color-graphite)" }}>
                    {service.detail}
                  </span>
                </div>
              </div>
            ))}
            <Rule />
          </div>
        ) : (
          <Empty>Probing.</Empty>
        )}
      </Section>

      <Section title="RESET THE DEMO">
        <Empty>
          Resetting is a signed action against a local validator, so it lives in a script rather
          than in this page. A web page that could reset a demo would need an authority nothing else
          in this design has, and the one place that kind of authority exists is a mock
          protocol&rsquo;s own demo instruction, which refuses unless its operator configured a demo
          authority up front.
        </Empty>
        <Card outlined>
          <pre
            className="mono"
            style={{
              margin: 0,
              overflowX: "auto",
              lineHeight: 1.7,
              color: "var(--color-almost-white)",
            }}
          >
            {`bash scripts/bootstrap-local.sh stop
bash scripts/bootstrap-local.sh start
pnpm exec tsx scripts/phase5-composition.ts`}
          </pre>
        </Card>
        <Fields>
          <Field label="Fresh ledger">
            Stopping and starting the stack discards the ledger, which is the only way to get a
            genuinely clean run rather than one layered on old state.
          </Field>
          <Field label="Rerunnable without a reset">
            The composition script walks to the first unused covenant id, so repeated runs on one
            ledger do not collide.
          </Field>
        </Fields>
      </Section>

      <Section title="POINT THIS APP SOMEWHERE ELSE">
        <Empty>
          Every endpoint is a query parameter, and none of them is a secret. This is what makes the
          proof path shareable: a link carries the cluster it was taken against.
        </Empty>
        <Card outlined>
          <Fields>
            <Field label="Local stack" mono>
              /proof
            </Field>
            <Field label="Devnet" mono>
              /proof?network=devnet
            </Field>
            <Field label="A specific node" mono>
              /proof?base=https://…&amp;er=https://…
            </Field>
            <Field label="A specific operation" mono>
              /proof?operation=&lt;64 hex&gt;
            </Field>
          </Fields>
        </Card>
      </Section>
    </>
  );
}

async function probe(options: {
  name: string;
  endpoint: string;
  method: string;
  purpose: string;
  degrades: string;
}): Promise<ServiceState> {
  const started = Date.now();
  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: options.method, params: [] }),
      signal: AbortSignal.timeout(6_000),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    const elapsed = Date.now() - started;
    // A JSON-RPC error still means the service answered. The question this row asks is whether
    // anyone is home, not whether the method exists.
    return {
      name: options.name,
      endpoint: options.endpoint,
      reachable: true,
      detail: body.error
        ? `answered in ${elapsed}ms with ${body.error.message ?? "an error"}`
        : `answered in ${elapsed}ms`,
      purpose: options.purpose,
      degrades: options.degrades,
    };
  } catch (error) {
    return {
      name: options.name,
      endpoint: options.endpoint,
      reachable: false,
      detail: error instanceof Error ? error.message : String(error),
      purpose: options.purpose,
      degrades: options.degrades,
    };
  }
}

export type { Tone };

/**
 * What is up, and what stops working when it is not.
 *
 * A status page that only shows dots makes an outage look cosmetic. Every row says what the
 * service is for and what degrades without it, because during an outage the useful question is
 * whether the thing you were about to do still works.
 */

import { SiteChrome } from "../components/SiteChrome";
import { Address, Card, Field, Fields, Loading, Pill, Section } from "../components/primitives";
import { useNetwork } from "../lib/network";
import { usePolled } from "../data/useChain";

interface Service {
  name: string;
  endpoint: string;
  reachable: boolean;
  detail: string;
  purpose: string;
  degrades: string;
}

export function Status() {
  const network = useNetwork();

  const { state } = usePolled<Service[]>(
    async () => {
      const services: Service[] = [
        await probe({
          name: "Solana base layer",
          endpoint: network.base,
          method: "getHealth",
          purpose:
            "Covenants, adapters, certificates, receipts, and every settled incident. The source of truth for anything VINCT claims.",
          degrades: "Everything. Nothing anywhere in the product is current without it.",
        }),
      ];
      if (network.ephemeral) {
        services.push(
          await probe({
            name: "Ephemeral rollup",
            endpoint: network.ephemeral,
            method: "getHealth",
            purpose:
              "Where a live incident's private state sits, where members answer, and where the expiry crank runs.",
            degrades:
              "New incidents cannot be opened or answered. Settled incidents are unaffected: they already returned to base.",
          }),
        );
      }
      if (network.router) {
        services.push(
          await probe({
            name: "MagicBlock router",
            endpoint: network.router,
            method: "getRoutes",
            purpose:
              "Resolves which rollup an account is delegated to. VINCT never hardcodes a regional endpoint.",
            degrades:
              "A live incident cannot be reached. VINCT refuses to guess an endpoint rather than send private state to the wrong rollup.",
          }),
        );
      }
      return services;
    },
    [network.base, network.ephemeral, network.router],
    15_000,
  );

  return (
    <SiteChrome>
      <div
        className="wrap page-offset"
        style={{ paddingInline: "var(--s5)", paddingBottom: "var(--s9)" }}
      >
        <header className="stack" style={{ gap: "var(--s3)", marginBottom: "var(--s6)" }}>
          <Pill>{network.label}</Pill>
          <h1 className="m-heading">Service status</h1>
          <p className="t-lead muted" style={{ maxWidth: "58ch" }}>
            What VINCT depends on, and what each outage would actually cost you.
          </p>
        </header>

        <Section title="Services">
          {state.status !== "ready" ? (
            <Loading rows={3} />
          ) : (
            <div className="stack" data-testid="service-list">
              {state.value.map((service) => (
                <Card key={service.name}>
                  <div className="stack">
                    <div className="row-between">
                      <span className="t-lead" style={{ fontWeight: 500 }}>
                        {service.name}
                      </span>
                      <Pill tone={service.reachable ? "ok" : "blocked"}>
                        {service.reachable ? "Reachable" : "Unreachable"}
                      </Pill>
                    </div>
                    <Address value={service.endpoint} full />
                    <p className="t-base muted" style={{ maxWidth: "70ch" }}>
                      {service.purpose}
                    </p>
                    {!service.reachable && (
                      <p className="t-base" style={{ color: "var(--lavender)", maxWidth: "70ch" }}>
                        {service.degrades}
                      </p>
                    )}
                    <span className="mono dim">{service.detail}</span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Point VINCT somewhere else"
          description="Every endpoint is a query parameter and none is a secret. That is what makes a proof link shareable: it carries the cluster it was taken against."
        >
          <Card>
            <Fields>
              <Field label="Devnet, the default" mono>
                /proof
              </Field>
              <Field label="A local stack" mono>
                /proof?network=local
              </Field>
              <Field label="A specific node" mono>
                /proof?base=https://…
              </Field>
              <Field label="A specific operation" mono>
                /proof/&lt;64 hex&gt;
              </Field>
            </Fields>
          </Card>
        </Section>
      </div>
    </SiteChrome>
  );
}

async function probe(options: {
  name: string;
  endpoint: string;
  method: string;
  purpose: string;
  degrades: string;
}): Promise<Service> {
  const started = Date.now();
  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: options.method, params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json()) as { error?: { message?: string } };
    const elapsed = Date.now() - started;
    // A JSON-RPC error still means somebody answered, which is what this row asks.
    return {
      name: options.name,
      endpoint: options.endpoint,
      reachable: true,
      detail: body.error
        ? `answered in ${elapsed}ms with "${body.error.message ?? "an error"}"`
        : `answered in ${elapsed}ms`,
      purpose: options.purpose,
      degrades: options.degrades,
    };
  } catch (cause) {
    return {
      name: options.name,
      endpoint: options.endpoint,
      reachable: false,
      detail: cause instanceof Error ? cause.message : String(cause),
      purpose: options.purpose,
      degrades: options.degrades,
    };
  }
}

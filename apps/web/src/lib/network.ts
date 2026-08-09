/**
 * Which chain this browser is talking to.
 *
 * Every endpoint is a query parameter and none is a secret, which is what makes a proof link
 * shareable: it carries the cluster it was taken against. A judge opening a link checks the same
 * chain the person who sent it checked.
 *
 * Deployed builds default to Devnet. A local stack is opt-in through the URL, so a hosted page
 * never quietly reports on a validator nobody else can reach.
 */

import { useLocation } from "react-router-dom";

export interface Network {
  id: "devnet" | "local" | "custom";
  label: string;
  base: string;
  /**
   * Where account scans go, which is not always where everything else goes.
   *
   * `getProgramAccounts` is how covenant membership and capability discovery work, and paid RPC
   * tiers commonly decline it. The deployment's proxy cannot simply forward the refusal to a
   * public endpoint either, because that endpoint blocks the datacentre addresses a Worker calls
   * from. A browser is not blocked, so the scan goes straight from the page and everything else
   * keeps the fast path.
   *
   * Equal to `base` when the two are the same, which is the case locally and for any custom
   * endpoint a reader names.
   */
  scan: string;
  ephemeral: string | null;
  router: string | null;
  /** True when the base layer is a validator only this machine can see. */
  isLocal: boolean;
}

/**
 * The deployed defaults, injected at build time rather than hardcoded.
 *
 * A public RPC is fine for reading and cannot sustain much else, so a deployment sets
 * `VITE_SOLANA_RPC` to a real endpoint. Nothing here is a secret: an RPC URL with a credential
 * in it would be visible in the bundle regardless, which is why the deploy uses a proxied or
 * unauthenticated endpoint and never a keyed one.
 *
 * No regional rollup is named. `ephemeral` is only a first candidate; `resolveRuntime` asks the
 * router what actually exists and refuses to guess when the two disagree.
 */
const DEVNET = {
  /*
   * The deployment's own proxy by default, so the upstream credential stays server-side.
   * A relative path works because the Worker serves the site and the proxy from one origin.
   * `?base=` still overrides it, which is how the tests point at anything else.
   */
  base: absolute(import.meta.env.VITE_SOLANA_RPC ?? "/rpc"),
  scan: import.meta.env.VITE_SOLANA_SCAN_RPC ?? "https://api.devnet.solana.com",
  ephemeral: import.meta.env.VITE_MAGICBLOCK_ER ?? "https://devnet-us.magicblock.app/",
  router: import.meta.env.VITE_MAGICBLOCK_ROUTER ?? "https://devnet-router.magicblock.app/",
};

const LOCAL = {
  base: "http://127.0.0.1:8899",
  ephemeral: "http://127.0.0.1:7799",
  router: null,
};

/**
 * Makes a relative endpoint absolute.
 *
 * The deployment points at its own `/rpc` proxy, and `Connection` rejects a relative URL: it
 * parses the endpoint eagerly and throws `Invalid URL` before any request is attempted. The
 * failure is silent in the worst way, because nothing is ever sent and there is no network error
 * to notice. Resolving against the current origin is all it needs.
 */
function absolute(endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (typeof window === "undefined") return `https://vinct.timjosh507.workers.dev${endpoint}`;
  return new URL(endpoint, window.location.origin).toString();
}

export function readNetwork(search: string): Network {
  const params = new URLSearchParams(search);
  const requested = params.get("network");
  // A deployed build never falls back to a validator only one machine can see. Local is opt-in
  // through the URL so a hosted page cannot quietly report on something nobody else can reach.
  const base = params.get("base");
  const ephemeral = params.get("er");
  const router = params.get("router");

  if (base || ephemeral) {
    return {
      id: "custom",
      label: "Custom endpoint",
      base: base ?? DEVNET.base,
      // A named endpoint is used for everything, including scans. Somebody who supplies one is
      // telling the app where to look, and silently reading elsewhere would ignore that.
      scan: base ?? DEVNET.scan,
      ephemeral: ephemeral ?? DEVNET.ephemeral,
      router: router ?? DEVNET.router,
      isLocal: (base ?? "").includes("127.0.0.1") || (base ?? "").includes("localhost"),
    };
  }

  if (requested === "local") {
    return { id: "local", label: "Local stack", ...LOCAL, scan: LOCAL.base, isLocal: true };
  }

  return { id: "devnet", label: "Solana Devnet", ...DEVNET, isLocal: false };
}

export function useNetwork(): Network {
  const location = useLocation();
  return readNetwork(location.search);
}

/** Keeps the current network on a link, so navigating never silently switches chains. */
export function withNetwork(
  pathname: string,
  search: string,
): { pathname: string; search: string } {
  return { pathname, search };
}

/** A Solana explorer link for the cluster in view. */
export function explorer(kind: "tx" | "address", value: string, network: Network): string | null {
  if (network.isLocal) return null;
  const cluster = network.id === "devnet" ? "?cluster=devnet" : "?cluster=devnet";
  return `https://explorer.solana.com/${kind}/${value}${cluster}`;
}

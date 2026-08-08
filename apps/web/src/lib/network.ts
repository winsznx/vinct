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
  ephemeral: string | null;
  router: string | null;
  /** True when the base layer is a validator only this machine can see. */
  isLocal: boolean;
}

const DEVNET = {
  base: "https://api.devnet.solana.com",
  ephemeral: "https://devnet-us.magicblock.app/",
  router: "https://devnet-router.magicblock.app/",
};

const LOCAL = {
  base: "http://127.0.0.1:8899",
  ephemeral: "http://127.0.0.1:7799",
  router: null,
};

export function readNetwork(search: string): Network {
  const params = new URLSearchParams(search);
  const requested = params.get("network");
  const base = params.get("base");
  const ephemeral = params.get("er");
  const router = params.get("router");

  if (base || ephemeral) {
    return {
      id: "custom",
      label: "Custom endpoint",
      base: base ?? DEVNET.base,
      ephemeral: ephemeral ?? DEVNET.ephemeral,
      router: router ?? DEVNET.router,
      isLocal: (base ?? "").includes("127.0.0.1") || (base ?? "").includes("localhost"),
    };
  }

  if (requested === "local") {
    return { id: "local", label: "Local stack", ...LOCAL, isLocal: true };
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

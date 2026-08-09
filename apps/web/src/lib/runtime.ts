/**
 * Which rollup to talk to, and whether it is safe to talk to.
 *
 * Two independent questions, and conflating them is how private material lands somewhere it
 * should not.
 *
 * Where. The router says which rollup an account is delegated to. VINCT never hardcodes a
 * regional endpoint, so this resolves live and reports which source answered. When the router
 * publishes routes and none of them is this account's validator, nothing is resolved at all
 * rather than falling through to a guess.
 *
 * Whether. A rollup caches a program's executable the first time it runs it, and a base-layer
 * upgrade does not evict that cache. Its account clone stays perfectly current, which is what
 * makes the situation dangerous: everything looks deployed while the rollup quietly runs the
 * previous binary. A member submitting a sealed attestation into that would be signing for
 * logic nobody deployed. So the fingerprint is checked before any write, and a mismatch is a
 * refusal rather than a warning.
 *
 * See docs/decision-log.md D-0030, D-0040 and D-0072.
 */

import { Connection, PublicKey } from "@solana/web3.js";

import { expectedBuildFingerprint, observedBuildFingerprint } from "../data/freshness";
import type { Network } from "./network";

export type RuntimeVerdict =
  /** Executing the build this frontend was compiled against. Writes are safe. */
  | { kind: "fresh"; endpoint: string; fingerprint: string; source: string }
  /** Reachable, and running something else. Reads fine, writes refused. */
  | { kind: "stale"; endpoint: string; observed: string | null; expected: string }
  /** The router contradicts the chain. Resolving anything would be a guess. */
  | { kind: "mismatch"; detail: string }
  /** Nothing answered. Distinct from stale: nothing is known either way. */
  | { kind: "unreachable"; detail: string };

export interface RouterRoute {
  identity: string;
  fqdn: string;
}

async function routerCall(router: string, method: string): Promise<unknown> {
  try {
    const response = await fetch(router, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    return body.error === undefined ? (body.result ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Finds a rollup that is executing this build.
 *
 * Tries the configured endpoint first, then anything the router advertises. Returning the first
 * reachable rollup would be the bug: reachable and current are different properties, and only
 * the second one makes a write safe.
 */
export async function resolveRuntime(
  network: Network,
  feePayer: PublicKey,
): Promise<RuntimeVerdict> {
  const expected = expectedBuildFingerprint();
  const candidates: string[] = [];

  if (network.ephemeral) candidates.push(network.ephemeral);

  if (network.router) {
    const routes = await routerCall(network.router, "getRoutes");
    if (Array.isArray(routes)) {
      for (const route of routes as RouterRoute[]) {
        if (route.fqdn && !candidates.includes(route.fqdn)) candidates.push(route.fqdn);
      }
    }
  }

  if (candidates.length === 0) {
    return { kind: "unreachable", detail: "No rollup endpoint was configured or advertised." };
  }

  let sawAnything = false;
  let lastObserved: string | null = null;

  for (const endpoint of candidates) {
    const observed = await observedBuildFingerprint(
      new Connection(endpoint, "confirmed"),
      feePayer,
    );
    if (observed.fingerprint === null) continue;
    sawAnything = true;
    lastObserved = observed.fingerprint;
    if (observed.fingerprint === expected) {
      return {
        kind: "fresh",
        endpoint,
        fingerprint: observed.fingerprint,
        source: endpoint === network.ephemeral ? "configured" : "router",
      };
    }
  }

  if (!sawAnything) {
    return {
      kind: "unreachable",
      detail: `None of ${candidates.length} advertised rollup(s) answered a build query.`,
    };
  }

  return {
    kind: "stale",
    endpoint: candidates[0] ?? "",
    observed: lastObserved,
    expected,
  };
}

/** True when this verdict permits writing private material. Only one kind does. */
export function permitsWrites(verdict: RuntimeVerdict | null): verdict is RuntimeVerdict & {
  kind: "fresh";
} {
  return verdict?.kind === "fresh";
}

/** What to tell somebody, in words rather than a fingerprint. */
export function describeRuntime(verdict: RuntimeVerdict): string {
  switch (verdict.kind) {
    case "fresh":
      return "The rollup is executing this build, so a response submitted here runs the logic you can read in the repository.";
    case "stale":
      return "The rollup is reachable and is executing a build this frontend was not compiled against. Submitting a response would sign for logic nobody deployed, so writing is disabled until it catches up.";
    case "mismatch":
      return "The router and the chain disagree about which rollup holds this account. VINCT will not guess an endpoint for private material.";
    case "unreachable":
      return "No rollup answered. Nothing is known about whether one is current, which is not the same as knowing one is stale.";
  }
}

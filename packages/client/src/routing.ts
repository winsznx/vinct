/**
 * Ephemeral rollup endpoint resolution.
 *
 * Phase 0 found that the PRD's routing instruction does not match observable behaviour. The
 * PRD says to resolve `getDelegationStatus` and use the returned `fqdn`, but the pinned SDK
 * types that method as `{ isDelegated: boolean }` and the live devnet router returned
 * exactly that for an undelegated account. See docs/decision-log.md D-0009.
 *
 * This module therefore resolves an endpoint from evidence rather than assumption, and
 * records which source actually answered. Three sources, in order of preference:
 *
 *   1. an `fqdn` on the router's `getDelegationStatus` response, if one is present
 *   2. the router's `getRoutes` table, matched on the validator identity in the account's
 *      delegation record
 *   3. an explicitly configured endpoint, for the local stack where there is no router
 *
 * A regional endpoint is never hardcoded. Where source 3 is used, the caller supplied it and
 * the result says so.
 */

import { Connection, PublicKey } from "@solana/web3.js";

/** One entry from the router's routing table. */
export interface RouterRoute {
  identity: string;
  fqdn: string;
  countryCode?: string;
  blockTimeMs?: number;
  baseFee?: number;
}

export type ResolutionSource =
  "getDelegationStatus.fqdn" | "getRoutes+delegationRecord" | "configured" | "unresolved";

export interface ResolvedEndpoint {
  endpoint: string | null;
  source: ResolutionSource;
  /** Everything observed while resolving, kept so an artifact can record the evidence. */
  evidence: {
    delegationStatus: unknown;
    delegationStatusFields: string[];
    routes: RouterRoute[];
    validatorIdentity: string | null;
    note: string;
  };
}

async function routerCall(router: string, method: string, params: unknown[]): Promise<unknown> {
  try {
    const response = await fetch(router, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    return body.error === undefined ? (body.result ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the validator identity out of a delegation record account.
 *
 * Layout: an 8-byte discriminator then the validator authority. The MagicBlock skill
 * documents this offset for the fee-vault derivation, and it is the only field this
 * resolver needs.
 */
export function validatorFromDelegationRecord(data: Buffer): PublicKey | null {
  if (data.length < 40) return null;
  return new PublicKey(data.subarray(8, 40));
}

export async function resolveEphemeralEndpoint(options: {
  router: string | null;
  baseConnection: Connection;
  delegatedAccount: PublicKey;
  delegationRecord: PublicKey;
  configuredEndpoint?: string | null;
}): Promise<ResolvedEndpoint> {
  const evidence: ResolvedEndpoint["evidence"] = {
    delegationStatus: null,
    delegationStatusFields: [],
    routes: [],
    validatorIdentity: null,
    note: "",
  };

  if (options.router) {
    const status = await routerCall(options.router, "getDelegationStatus", [
      options.delegatedAccount.toBase58(),
    ]);
    evidence.delegationStatus = status;
    if (status && typeof status === "object") {
      evidence.delegationStatusFields = Object.keys(status as Record<string, unknown>).sort();
      const fqdn = (status as Record<string, unknown>).fqdn;
      if (typeof fqdn === "string" && fqdn.length > 0) {
        evidence.note =
          "getDelegationStatus carried an fqdn for a delegated account, which confirms the PRD's routing instruction.";
        return { endpoint: fqdn, source: "getDelegationStatus.fqdn", evidence };
      }
    }

    const routes = await routerCall(options.router, "getRoutes", []);
    if (Array.isArray(routes)) {
      evidence.routes = routes as RouterRoute[];
    }

    const record = await options.baseConnection.getAccountInfo(options.delegationRecord);
    if (record) {
      const validator = validatorFromDelegationRecord(record.data);
      if (validator) {
        evidence.validatorIdentity = validator.toBase58();
        const match = evidence.routes.find((route) => route.identity === validator.toBase58());
        if (match) {
          evidence.note =
            "getDelegationStatus carried no fqdn. Resolved by matching the delegation record's validator identity against the router's getRoutes table.";
          return { endpoint: match.fqdn, source: "getRoutes+delegationRecord", evidence };
        }
      }
    }
  }

  if (options.configuredEndpoint) {
    evidence.note =
      "No router resolution available. Using the explicitly configured endpoint, which is only appropriate for the local stack.";
    return { endpoint: options.configuredEndpoint, source: "configured", evidence };
  }

  evidence.note = "No endpoint could be resolved from the router or from configuration.";
  return { endpoint: null, source: "unresolved", evidence };
}

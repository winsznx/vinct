/**
 * Records what the MagicBlock router actually advertises, so no endpoint in this
 * repository is ever a remembered constant.
 *
 * Phase 0 scope: capture the response shapes. It deliberately does not create or
 * delegate an account, so it cannot answer whether a *delegated* account's
 * `getDelegationStatus` response carries the ER `fqdn`. That question is left open
 * and must be answered with a real delegated account in a later phase.
 *
 *   pnpm exec tsx scripts/probe-router.ts
 *   pnpm exec tsx scripts/probe-router.ts -- --account <pubkey>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "source-lock");
const ROUTER = process.env.VINCT_DEVNET_ROUTER ?? "https://devnet-router.magicblock.app/";
const TIMEOUT_MS = 15_000;

/** The all-zero system program address: guaranteed to exist and never be delegated. */
const UNDELEGATED_PROBE_ACCOUNT = "11111111111111111111111111111111";

interface RpcResult {
  method: string;
  params: unknown[];
  ok: boolean;
  result: unknown;
  error: unknown;
}

async function rpc(method: string, params: unknown[]): Promise<RpcResult> {
  try {
    const response = await fetch(ROUTER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    return {
      method,
      params,
      ok: response.ok && body.error === undefined,
      result: body.result ?? null,
      error: body.error ?? null,
    };
  } catch (cause) {
    return {
      method,
      params,
      ok: false,
      result: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function accountArg(argv: readonly string[]): string {
  const index = argv.indexOf("--account");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ?? UNDELEGATED_PROBE_ACCOUNT;
}

async function main(): Promise<void> {
  const account = accountArg(process.argv.slice(2));
  const capturedAt = new Date().toISOString();

  const routes = await rpc("getRoutes", []);
  const delegationStatus = await rpc("getDelegationStatus", [account]);

  const advertised = Array.isArray(routes.result)
    ? (routes.result as Array<Record<string, unknown>>).map((r) => ({
        identity: String(r.identity ?? ""),
        fqdn: String(r.fqdn ?? ""),
        countryCode: String(r.countryCode ?? ""),
        blockTimeMs: Number(r.blockTimeMs ?? 0),
      }))
    : [];

  const statusResult = delegationStatus.result as Record<string, unknown> | null;
  const delegationStatusFields = statusResult ? Object.keys(statusResult).sort() : [];

  const artifact = {
    captured_at: capturedAt,
    router: ROUTER,
    probe_account: account,
    probe_account_is_known_delegated: account !== UNDELEGATED_PROBE_ACCOUNT,
    advertised_routes: advertised,
    calls: [routes, delegationStatus],
    findings: {
      get_delegation_status_fields: delegationStatusFields,
      get_delegation_status_includes_fqdn: delegationStatusFields.includes("fqdn"),
      note:
        account === UNDELEGATED_PROBE_ACCOUNT
          ? "Probed with an undelegated account. Whether a delegated account's response carries an fqdn is UNVERIFIED. Re-run with --account <delegated pubkey> before relying on it."
          : "Probed with the supplied account. Compare fields against the undelegated baseline.",
    },
  };

  await mkdir(ARTIFACT_DIR, { recursive: true });
  const stamped = capturedAt.replace(/[:.]/g, "-");
  await writeFile(
    join(ARTIFACT_DIR, `router-probe-${stamped}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  await writeFile(
    join(ARTIFACT_DIR, "router-probe-latest.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  console.log(`router=${ROUTER} captured_at=${capturedAt}`);
  for (const route of advertised) {
    console.log(`  ${route.countryCode.padEnd(4)} ${route.fqdn.padEnd(40)} ${route.identity}`);
  }
  console.log(`  getDelegationStatus(${account}) -> {${delegationStatusFields.join(", ")}}`);

  if (!routes.ok) {
    console.error("getRoutes failed; no endpoint may be inferred from this run.");
    process.exitCode = 1;
  }
}

await main();

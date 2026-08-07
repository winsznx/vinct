/**
 * Captures the live MagicBlock service status and writes a timestamped artifact.
 *
 * The status API is the source of truth for service health. Never answer from a
 * remembered snapshot, and never continue a rehearsal against a dependency this
 * script reports as down.
 *
 * When the API is unreachable, this script still writes an artifact recording the
 * failure. An explicit "unavailable" record is evidence; silence is not.
 *
 *   pnpm check-magicblock-status
 *   pnpm check-magicblock-status -- --network devnet --require er,rpc_router
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS_API = process.env.VINCT_STATUS_API ?? "https://status.magicblock.app/api/services";
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "source-lock");
const REQUEST_TIMEOUT_MS = 15_000;

type LiveStatus = Record<string, boolean | undefined>;

interface ServerEntry {
  live_status?: LiveStatus;
  metrics?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RegionEntry {
  servers?: Record<string, ServerEntry>;
  [key: string]: unknown;
}

interface EnvironmentEntry {
  regions?: Record<string, RegionEntry>;
  [key: string]: unknown;
}

interface StatusPayload {
  meta?: { services?: unknown; days?: unknown };
  environments?: Record<string, EnvironmentEntry>;
  [key: string]: unknown;
}

interface ServiceObservation {
  network: string;
  region: string;
  fqdn: string;
  service: string;
  /** true = Operational, false = Down, null = not advertised for this server. */
  status: boolean | null;
}

function parseArgs(argv: readonly string[]): { network: string; required: string[] } {
  let network = "devnet";
  let required: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--network" && argv[i + 1] !== undefined) {
      network = argv[i + 1] as string;
      i += 1;
    } else if (arg === "--require" && argv[i + 1] !== undefined) {
      required = (argv[i + 1] as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    }
  }
  return { network, required };
}

function flatten(payload: StatusPayload, network: string): ServiceObservation[] {
  const out: ServiceObservation[] = [];
  const environment = payload.environments?.[network];
  for (const [region, regionEntry] of Object.entries(environment?.regions ?? {})) {
    for (const [fqdn, server] of Object.entries(regionEntry.servers ?? {})) {
      const live = server.live_status ?? {};
      for (const [service, status] of Object.entries(live)) {
        out.push({
          network,
          region,
          fqdn,
          service,
          status: status === undefined ? null : status,
        });
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { network, required } = parseArgs(process.argv.slice(2));
  const capturedAt = new Date().toISOString();

  let payload: StatusPayload | null = null;
  let error: string | null = null;
  let httpStatus: number | null = null;

  try {
    const response = await fetch(STATUS_API, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    httpStatus = response.status;
    if (!response.ok) {
      error = `status API returned HTTP ${response.status}`;
    } else {
      payload = (await response.json()) as StatusPayload;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const observations = payload ? flatten(payload, network) : [];
  const down = observations.filter((o) => o.status === false);

  const artifact = {
    captured_at: capturedAt,
    source: STATUS_API,
    network,
    reachable: payload !== null,
    http_status: httpStatus,
    error,
    services_advertised: payload?.meta?.services ?? null,
    observations,
    down,
    raw: payload,
  };

  await mkdir(ARTIFACT_DIR, { recursive: true });
  const stamped = capturedAt.replace(/[:.]/g, "-");
  await writeFile(
    join(ARTIFACT_DIR, `magicblock-status-${network}-${stamped}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  await writeFile(
    join(ARTIFACT_DIR, `magicblock-status-${network}-latest.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  if (!payload) {
    console.error(`MagicBlock status API unavailable: ${error ?? "unknown error"}`);
    console.error("Artifact written with reachable=false. Do not claim live service health.");
    process.exitCode = 1;
    return;
  }

  console.log(`network=${network} captured_at=${capturedAt}`);
  for (const o of observations) {
    const label = o.status === null ? "n/a" : o.status ? "operational" : "DOWN";
    console.log(`  ${o.region.padEnd(7)} ${o.fqdn.padEnd(32)} ${o.service.padEnd(15)} ${label}`);
  }

  const missing = required.filter(
    (service) => !observations.some((o) => o.service === service && o.status === true),
  );
  if (missing.length > 0) {
    console.error(`Required services not operational on ${network}: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
}

await main();

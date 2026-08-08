/**
 * What the connected wallet is part of, in as few round trips as possible.
 *
 * The first version read one account at a time. On a public Devnet endpoint a single
 * `getAccountInfo` takes about three seconds, so thirty sequential reads left the dashboard
 * showing skeletons for over a minute. Batching is not an optimisation here, it is the
 * difference between a usable page and an unusable one.
 *
 * Four round trips now, regardless of how many covenants are in view: memberships in one scan,
 * every covenant account in one multi-read, capabilities in one scan, and every candidate
 * incident in one more multi-read.
 *
 * Discovery is the awkward part. A covenant does not list its members, and a membership account
 * carries its covenant rather than the reverse, so finding "every covenant this wallet belongs
 * to" needs a program scan. Several hosted RPC tiers disable that scan, and a page reporting the
 * refusal as "you are in no covenants" would be telling somebody their memberships do not exist
 * because of a billing plan. So the refusal is its own state, and the demo covenant is always
 * reachable by address, which needs no scan at all.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { useMemo } from "react";

import {
  ADAPTER_PROGRAM_ID,
  CORE_PROGRAM_ID,
  CovenantStatus,
  IncidentStatus,
  attestationAddress,
  claimAddress,
  decodeCapability,
  decodeCovenant,
  decodeCovenantMember,
  decodeIncidentClaim,
  decodeIncidentCore,
  decodeMemberAttestation,
  incidentAddress,
  type CovenantMemberView,
  type CovenantView as CovenantAccount,
} from "@vinct/client";

import type { IncidentView } from "../data/chain";
import { usePolled, type ReadState } from "../data/useChain";
import { DEMO_COVENANT, PROTOCOL_NAMES } from "./demo";
import type { Network } from "./network";
import type { Role } from "./wallet";

export interface CovenantSummary {
  address: PublicKey;
  covenant: CovenantAccount;
  members: { address: PublicKey; member: CovenantMemberView }[];
  incidents: IncidentView[];
  capabilities: { address: PublicKey; authority: PublicKey; armed: boolean; suspended: boolean }[];
  /** The connected wallet's standing in this covenant. */
  role: Role;
  /** True when the covenant armed and every member armed its own adapter. */
  ready: boolean;
}

export class DiscoveryUnavailable extends Error {
  constructor() {
    super("This RPC will not run the account scan that finds memberships.");
    this.name = "DiscoveryUnavailable";
  }
}

const MEMBERSHIP_PROTOCOL_OFFSET = 8 + 2 + 32;
/** `CovenantMember::SIZE` plus the discriminator, used to filter a scan cheaply. */
const MEMBERSHIP_SIZE = 8 + (2 + 32 + 32 + 1 + 32 + 2 + 1 + 1 + 1);

/** How many incident ids to probe. Ids are dense from one, so this is a ceiling, not a scan. */
const INCIDENT_PROBE_DEPTH = 12;

export function useCovenants(
  network: Network,
  wallet: PublicKey | null,
): { state: ReadState<CovenantSummary[]>; refresh: () => void } {
  const walletKey = wallet?.toBase58() ?? null;

  return usePolled<CovenantSummary[]>(
    async () => {
      const connection = new Connection(network.base, "confirmed");

      // 1. Which covenants matter. The demo one always, plus anything this wallet joined.
      const addresses = new Set<string>([DEMO_COVENANT]);
      if (walletKey) {
        try {
          const memberships = await connection.getProgramAccounts(CORE_PROGRAM_ID, {
            filters: [{ memcmp: { offset: MEMBERSHIP_PROTOCOL_OFFSET, bytes: walletKey } }],
          });
          for (const { account } of memberships) {
            try {
              addresses.add(decodeCovenantMember(account.data).covenant.toBase58());
            } catch {
              // Another account type happens to match at that offset. The discriminator check
              // separates them, which is exactly what it is for.
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/getProgramAccounts/i.test(message)) throw new DiscoveryUnavailable();
          throw error;
        }
      }

      const keys = [...addresses].map((address) => new PublicKey(address));

      // 2, 3. Covenant accounts, memberships, and capabilities, concurrently.
      const [covenantAccounts, allMembers, allCapabilities] = await Promise.all([
        connection.getMultipleAccountsInfo(keys),
        scanMembers(connection),
        scanCapabilities(connection),
      ]);

      // 4. Candidate incident addresses for every covenant, in one read.
      const probes: { covenant: string; address: PublicKey }[] = [];
      for (const key of keys) {
        for (let id = 1n; id <= BigInt(INCIDENT_PROBE_DEPTH); id += 1n) {
          probes.push({ covenant: key.toBase58(), address: incidentAddress(key, id) });
        }
      }
      const incidentAccounts = await connection.getMultipleAccountsInfo(
        probes.map((probe) => probe.address),
      );

      const summaries: CovenantSummary[] = [];
      for (const [index, key] of keys.entries()) {
        const account = covenantAccounts[index];
        if (!account) continue;

        let covenant: CovenantAccount;
        try {
          covenant = decodeCovenant(account.data);
        } catch {
          continue;
        }

        const members = allMembers
          .filter((entry) => entry.member.covenant.equals(key))
          .sort((a, b) =>
            Buffer.compare(a.member.protocol.toBuffer(), b.member.protocol.toBuffer()),
          );

        const capabilities = allCapabilities.filter((entry) => entry.covenant.equals(key));

        const incidents: IncidentView[] = [];
        for (const [probeIndex, probe] of probes.entries()) {
          if (probe.covenant !== key.toBase58()) continue;
          const incidentAccount = incidentAccounts[probeIndex];
          // Ids are dense, so the first gap ends this covenant's list.
          if (!incidentAccount) break;
          try {
            incidents.push({
              address: probe.address,
              core: decodeIncidentCore(incidentAccount.data),
              delegated: !incidentAccount.owner.equals(CORE_PROGRAM_ID),
              privacy: null,
            });
          } catch {
            break;
          }
        }

        summaries.push({
          address: key,
          covenant,
          members,
          incidents,
          capabilities,
          role: resolveRole(wallet, covenant, members),
          ready:
            covenant.status === CovenantStatus.Armed &&
            members.length > 0 &&
            members.every((entry) => entry.member.armed),
        });
      }

      return summaries;
    },
    [network.base, walletKey],
    20_000,
  );
}

/**
 * Every membership account the core program owns.
 *
 * Filtered by size rather than by covenant, so one scan serves every covenant in view. A node
 * that refuses the scan degrades a covenant to "no members listed" rather than failing the page,
 * because the caller's own discovery attempt already reports the refusal properly.
 */
async function scanMembers(
  connection: Connection,
): Promise<{ address: PublicKey; member: CovenantMemberView }[]> {
  try {
    const accounts = await connection.getProgramAccounts(CORE_PROGRAM_ID, {
      filters: [{ dataSize: MEMBERSHIP_SIZE }],
    });
    const found: { address: PublicKey; member: CovenantMemberView }[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        found.push({ address: pubkey, member: decodeCovenantMember(account.data) });
      } catch {
        // Not a membership, despite the size match.
      }
    }
    return found;
  } catch {
    return [];
  }
}

async function scanCapabilities(connection: Connection): Promise<
  {
    address: PublicKey;
    covenant: PublicKey;
    authority: PublicKey;
    armed: boolean;
    suspended: boolean;
  }[]
> {
  try {
    const accounts = await connection.getProgramAccounts(ADAPTER_PROGRAM_ID, {});
    const found = [];
    for (const { pubkey, account } of accounts) {
      try {
        const capability = decodeCapability(account.data);
        found.push({
          address: pubkey,
          covenant: capability.covenant,
          authority: capability.protocolAuthority,
          armed: capability.armed,
          suspended: capability.suspended,
        });
      } catch {
        // Adapter receipts and other account types land here.
      }
    }
    return found;
  } catch {
    return [];
  }
}

function resolveRole(
  wallet: PublicKey | null,
  covenant: CovenantAccount,
  members: { member: CovenantMemberView }[],
): Role {
  if (!wallet) return { kind: "disconnected" };
  if (covenant.steward.equals(wallet)) return { kind: "steward", address: wallet };
  const membership = members.find((entry) => entry.member.protocol.equals(wallet));
  if (membership) {
    return {
      kind: "member",
      address: wallet,
      ratified: membership.member.ratified,
      armed: membership.member.armed,
    };
  }
  return { kind: "unrelated", address: wallet };
}

/**
 * The privacy state of one incident's family, read only when somebody opens it.
 *
 * Kept out of the list load on purpose: it costs a read per ballot and nothing in a list needs
 * it. Returns `null` while the accounts are on the rollup, because a base-layer reader genuinely
 * cannot see them then, and saying so beats showing a stale snapshot as current.
 */
export async function readIncidentPrivacy(
  connection: Connection,
  incident: PublicKey,
  members: PublicKey[],
): Promise<IncidentView["privacy"]> {
  const addresses = [
    claimAddress(incident),
    ...members.map((m) => attestationAddress(incident, m)),
  ];
  const accounts = await connection.getMultipleAccountsInfo(addresses);
  const claimAccount = accounts[0];
  if (!claimAccount) return null;

  let claimZeroized = false;
  try {
    claimZeroized = decodeIncidentClaim(claimAccount.data).protectedRegionAllZero;
  } catch {
    return null;
  }

  let ballotCount = 0;
  let ballotsZeroized = true;
  for (const account of accounts.slice(1)) {
    if (!account) continue;
    try {
      ballotCount += 1;
      if (!decodeMemberAttestation(account.data).protectedRegionAllZero) ballotsZeroized = false;
    } catch {
      return null;
    }
  }
  return { claimZeroized, ballotsZeroized, ballotCount };
}

/** A readable name for a covenant, since covenants carry an address and not a title. */
export function covenantName(summary: CovenantSummary): string {
  if (summary.address.toBase58() === DEMO_COVENANT) return "Shared price feed";
  return `Covenant ${summary.address.toBase58().slice(0, 4)}`;
}

export function protocolName(address: PublicKey, index?: number): string {
  const names = Object.values(PROTOCOL_NAMES);
  if (index !== undefined && names[index]) return names[index]!;
  const text = address.toBase58();
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** Incidents that need somebody to act, across every covenant. */
export function needsAttention(summaries: CovenantSummary[]): {
  covenant: CovenantSummary;
  incident: IncidentView;
}[] {
  const found: { covenant: CovenantSummary; incident: IncidentView }[] = [];
  for (const summary of summaries) {
    if (summary.role.kind !== "member" && summary.role.kind !== "responder") continue;
    for (const incident of summary.incidents) {
      if (incident.core.status === IncidentStatus.Collecting) {
        found.push({ covenant: summary, incident });
      }
    }
  }
  return found;
}

export function useCovenant(
  network: Network,
  wallet: PublicKey | null,
  address: string | undefined,
): { state: ReadState<CovenantSummary[]>; covenant: CovenantSummary | null } {
  const { state } = useCovenants(network, wallet);
  const covenant = useMemo(() => {
    if (state.status !== "ready" || !address) return null;
    return state.value.find((entry) => entry.address.toBase58() === address) ?? null;
  }, [state, address]);
  return { state, covenant };
}

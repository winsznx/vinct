/**
 * Reading VINCT's state, with the same decoders every other surface uses.
 *
 * No decoder is written here. `packages/client` owns them and they are pinned to vectors the
 * programs generate, which is the fix for the class of bug where a UI reads plausible numbers
 * off a drifted layout and prints them next to a green tick. See docs/decision-log.md D-0051.
 *
 * Two things this module refuses to do. It never returns the contents of a private account,
 * only whether the protected region is zero. And it never reports an effect it could not
 * read: an unreachable RPC comes back as an error, not as an absence.
 */

import { Connection, PublicKey } from "@solana/web3.js";

import {
  ADAPTER_PROGRAM_ID,
  CORE_PROGRAM_ID,
  IncidentStatus,
  adapterReceiptAddress,
  attestationAddress,
  certificateAddress,
  claimAddress,
  covenantMemberAddress,
  decodeAdapterReceipt,
  decodeCapability,
  decodeCertificate,
  decodeCovenant,
  decodeCovenantMember,
  decodeIncidentClaim,
  decodeIncidentCore,
  decodeMarket,
  decodeMemberAttestation,
  decodeSettlementReceipt,
  incidentAddress,
  settlementReceiptAddress,
  type CovenantView as CovenantAccount,
  type CovenantMemberView,
  type IncidentCertificate,
  type IncidentCoreView,
  type SovereignCapability,
} from "@vinct/client";

export interface CovenantView {
  address: PublicKey;
  covenant: CovenantAccount;
  members: { address: PublicKey; member: CovenantMemberView }[];
}

export interface IncidentView {
  address: PublicKey;
  core: IncidentCoreView;
  /** Whether the incident's accounts are currently delegated away from the base layer. */
  delegated: boolean;
  /**
   * The privacy state of the whole private family, and nothing about its contents.
   *
   * `null` when the accounts are on the rollup and this base-layer reader cannot see them,
   * which is the normal case while an incident is live.
   */
  privacy: {
    claimZeroized: boolean;
    ballotsZeroized: boolean;
    ballotCount: number;
  } | null;
}

export interface SettlementView {
  operationId: Uint8Array;
  certificate: IncidentCertificate | null;
  settlementFinalized: boolean;
  adapters: {
    capability: PublicKey;
    label: string;
    receiptExists: boolean;
    executed: boolean;
    targetEffectApplied: boolean;
  }[];
}

export function connect(endpoint: string): Connection {
  return new Connection(endpoint, { commitment: "confirmed" });
}

/** The covenant and every membership it names, read from the chain. */
export async function readCovenant(
  connection: Connection,
  address: PublicKey,
  protocols: PublicKey[],
): Promise<CovenantView | null> {
  const account = await connection.getAccountInfo(address);
  if (!account) return null;
  const covenant = decodeCovenant(account.data);

  const members: CovenantView["members"] = [];
  for (const protocol of protocols) {
    const membershipAddress = covenantMemberAddress(address, protocol);
    const membership = await connection.getAccountInfo(membershipAddress);
    if (membership) {
      members.push({
        address: membershipAddress,
        member: decodeCovenantMember(membership.data),
      });
    }
  }
  return { address, covenant, members };
}

/**
 * Raised when the node refuses the scan this discovery depends on.
 *
 * Several hosted RPCs disable `getProgramAccounts` on their cheaper tiers. That is a property
 * of the endpoint rather than of the chain, and a page that reported it as "no members" would
 * be telling somebody a covenant is empty because of a billing plan.
 */
export class DiscoveryUnavailable extends Error {
  constructor(readonly endpointMessage: string) {
    super(
      "This RPC does not allow getProgramAccounts, which is how members and capabilities are " +
        "found. Supply them in the URL, or point the app at a node that permits the scan.",
    );
    this.name = "DiscoveryUnavailable";
  }
}

function isScanRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /getProgramAccounts/i.test(message) &&
    /not available|disabled|not supported|tier/i.test(message)
  );
}

/**
 * Finds the memberships of a covenant without being told who the members are.
 *
 * A membership account carries its covenant, so the whole set can be found by scanning the
 * program for accounts whose covenant field matches. The offset is the discriminator plus the
 * schema version, and the filter is a `memcmp` the RPC applies, so the browser downloads only
 * the matching accounts.
 *
 * `protocols` short-circuits the scan. When the caller already knows who the members are, their
 * membership addresses are derived rather than discovered, which is both cheaper and the only
 * path that works against a node that refuses the scan.
 */
export async function findCovenantMembers(
  connection: Connection,
  covenant: PublicKey,
  protocols?: PublicKey[],
): Promise<{ address: PublicKey; member: CovenantMemberView }[]> {
  if (protocols && protocols.length > 0) {
    const derived: { address: PublicKey; member: CovenantMemberView }[] = [];
    for (const protocol of protocols) {
      const address = covenantMemberAddress(covenant, protocol);
      const account = await connection.getAccountInfo(address);
      if (account) derived.push({ address, member: decodeCovenantMember(account.data) });
    }
    return derived;
  }

  const COVENANT_FIELD_OFFSET = 8 + 2;
  let accounts;
  try {
    accounts = await connection.getProgramAccounts(CORE_PROGRAM_ID, {
      filters: [{ memcmp: { offset: COVENANT_FIELD_OFFSET, bytes: covenant.toBase58() } }],
    });
  } catch (error) {
    if (isScanRefusal(error)) throw new DiscoveryUnavailable(String(error));
    throw error;
  }
  const members: { address: PublicKey; member: CovenantMemberView }[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      members.push({ address: pubkey, member: decodeCovenantMember(account.data) });
    } catch {
      // Not a membership. The filter matches on one field, and other account types carry a
      // covenant at the same offset; the decoder's discriminator check is what separates them.
    }
  }
  return members.sort((a, b) =>
    Buffer.compare(a.member.protocol.toBuffer(), b.member.protocol.toBuffer()),
  );
}

/** Every incident opened under one covenant. */
export async function findIncidents(
  connection: Connection,
  covenant: PublicKey,
): Promise<IncidentView[]> {
  const found: IncidentView[] = [];
  // Incident ids are dense from one, so walking them is cheaper and more predictable than a
  // program scan, and it keeps the ordering meaningful rather than address-sorted.
  for (let id = 1n; id <= 32n; id += 1n) {
    const address = incidentAddress(covenant, id);
    const view = await readIncident(connection, address);
    if (!view) break;
    found.push(view);
  }
  return found;
}

export async function readIncident(
  connection: Connection,
  address: PublicKey,
): Promise<IncidentView | null> {
  const account = await connection.getAccountInfo(address);
  if (!account) return null;

  // An account the delegation program owns is on a rollup, and its bytes here are a stale
  // snapshot. Saying so is more useful than showing the snapshot as if it were current.
  const delegated = !account.owner.equals(CORE_PROGRAM_ID);
  let core: IncidentCoreView;
  try {
    core = decodeIncidentCore(account.data);
  } catch {
    return null;
  }

  let privacy: IncidentView["privacy"] = null;
  if (!delegated) {
    const claimAccount = await connection.getAccountInfo(claimAddress(address));
    const claim = claimAccount ? decodeIncidentClaim(claimAccount.data) : null;
    let ballotCount = 0;
    let ballotsZeroized = true;
    // The member set is frozen in the core, but the core does not list the members. Their
    // ballots are found the same way the program reconstructs them: by address.
    const members = await findCovenantMembers(connection, core.covenant);
    for (const { member } of members) {
      const ballotAccount = await connection.getAccountInfo(
        attestationAddress(address, member.protocol),
      );
      if (!ballotAccount) continue;
      ballotCount += 1;
      if (!decodeMemberAttestation(ballotAccount.data).protectedRegionAllZero) {
        ballotsZeroized = false;
      }
    }
    privacy = {
      claimZeroized: claim?.protectedRegionAllZero ?? false,
      ballotsZeroized,
      ballotCount,
    };
  }

  return { address, core, delegated, privacy };
}

/** Every capability armed against one covenant, with the market each one guards. */
export async function findCapabilities(
  connection: Connection,
  covenant: PublicKey,
): Promise<
  {
    address: PublicKey;
    capability: SovereignCapability;
    marketPaused: boolean | null;
    marketUpdateCount: bigint | null;
  }[]
> {
  const COVENANT_FIELD_OFFSET = 8 + 32 + 32 + 32 + 2 + 32;
  let accounts;
  try {
    accounts = await connection.getProgramAccounts(ADAPTER_PROGRAM_ID, {
      filters: [{ memcmp: { offset: COVENANT_FIELD_OFFSET, bytes: covenant.toBase58() } }],
    });
  } catch (error) {
    if (isScanRefusal(error)) throw new DiscoveryUnavailable(String(error));
    throw error;
  }

  const found = [];
  for (const { pubkey, account } of accounts) {
    let capability: SovereignCapability;
    try {
      capability = decodeCapability(account.data);
    } catch {
      continue;
    }
    const marketAccount = await connection.getAccountInfo(capability.protocolState);
    let marketPaused: boolean | null = null;
    let marketUpdateCount: bigint | null = null;
    if (marketAccount) {
      try {
        const market = decodeMarket(marketAccount.data);
        marketPaused = market.newBorrowingPaused;
        marketUpdateCount = market.updateCount;
      } catch {
        // The capability guards an account this build does not know how to read. That is the
        // normal case for a real protocol, and it is not an error: the capability's own bounds
        // are still readable, and they are what the adapter enforces.
      }
    }
    found.push({ address: pubkey, capability, marketPaused, marketUpdateCount });
  }
  return found;
}

/** Everything one operation's settlement produced, read from base. */
export async function readSettlement(
  connection: Connection,
  operationId: Uint8Array,
  capabilities: { address: PublicKey; label: string }[],
): Promise<SettlementView> {
  const certificateAccount = await connection.getAccountInfo(certificateAddress(operationId));
  const certificate = certificateAccount ? decodeCertificate(certificateAccount.data) : null;

  const settlementAccount = await connection.getAccountInfo(settlementReceiptAddress(operationId));
  const settlementFinalized = settlementAccount
    ? decodeSettlementReceipt(settlementAccount.data).finalized
    : false;

  const adapters = [];
  for (const capability of capabilities) {
    const receiptAccount = await connection.getAccountInfo(
      adapterReceiptAddress(operationId, capability.address),
    );
    const receipt = receiptAccount ? decodeAdapterReceipt(receiptAccount.data) : null;
    adapters.push({
      capability: capability.address,
      label: capability.label,
      receiptExists: receipt !== null,
      executed: receipt?.executed ?? false,
      targetEffectApplied: receipt?.targetEffectApplied ?? false,
    });
  }

  return { operationId, certificate, settlementFinalized, adapters };
}

/** True when an incident has reached a status it cannot leave. */
export function isTerminal(status: IncidentStatus): boolean {
  return status !== IncidentStatus.Draft && status !== IncidentStatus.Collecting;
}

export function shortAddress(address: PublicKey | string): string {
  const text = typeof address === "string" ? address : address.toBase58();
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

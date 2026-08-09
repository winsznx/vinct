/**
 * Forming a covenant from the browser, one signature at a time.
 *
 * The product's central claim is that nobody can form a covenant alone, so this module is
 * deliberately incapable of shortcutting it. Each function does exactly the work one key is
 * entitled to do, and every one of them signs with the connected wallet.
 *
 * There is no path here that convenes a covenant and ratifies its members in one click. That
 * would need three protocol keys in one browser, which is precisely the arrangement the design
 * exists to make unnecessary. What the interface can do is tell each participant what is
 * outstanding and let them do their own part when it is their turn.
 *
 * The steward convenes and adds members, and can do nothing else. Each protocol ratifies and
 * arms only its own membership. The two covenant-level steps take no signature at all, because
 * by the time they run every signature that mattered has already been given, which is why
 * anybody can send them.
 */

import { Connection, PublicKey } from "@solana/web3.js";

import {
  CORE_PROGRAM_ID,
  MOCK_PROTOCOL_PROGRAM_ID,
  actionTemplateHash,
  adapterSignerAddress,
  addCovenantMember,
  armCapability,
  armCovenant,
  armCovenantMember,
  capabilityAddress,
  covenantAddress,
  covenantMemberAddress,
  createCovenant,
  installCapability,
  ratifyCovenant,
  ratifyCovenantMember,
  suspendCapability,
} from "@vinct/client";

import { sendWithWallet } from "./sign";
import type { WalletState } from "./wallet";

/** A digest, for a policy identifier or a template commitment. */
async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export interface CovenantDraft {
  /** What the members share, and what this covenant exists for. */
  dependency: string;
  /** Protocol authority addresses. Naming somebody grants nothing; they still ratify. */
  members: PublicKey[];
  requiredApprovals: number;
  maximumRejections: number;
  responseWindowSlots: bigint;
}

/**
 * The next free covenant id for this steward.
 *
 * Ids are dense from one, so the first gap is the answer. Probing beats storing a counter
 * somewhere off chain, which would be a second source of truth about what exists.
 */
export async function nextCovenantId(connection: Connection, steward: PublicKey): Promise<bigint> {
  const probes = Array.from({ length: 24 }, (_, index) =>
    covenantAddress(steward, BigInt(index + 1)),
  );
  const accounts = await connection.getMultipleAccountsInfo(probes);
  const free = accounts.findIndex((account) => account === null);
  if (free === -1) throw new Error("This steward already has 24 covenants on this cluster.");
  return BigInt(free + 1);
}

/**
 * Convenes the covenant. Signed by the steward, and by nobody else ever.
 *
 * Returns the address so the caller can send people to it. Nothing is agreed yet: at this point
 * the covenant exists and has no members, which is the honest state to show.
 */
export async function convene(
  connection: Connection,
  wallet: WalletState,
  draft: CovenantDraft,
  clusterGenesisHash: Uint8Array,
): Promise<{ covenant: PublicKey; signature: string; covenantId: bigint }> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const covenantId = await nextCovenantId(connection, wallet.publicKey);

  // The policy identifier commits to what this covenant is for. Derived from the dependency so
  // two covenants over the same thing agree, and so it is reproducible by anyone reading it.
  const policyId = await sha256(`vinct:policy:${draft.dependency.trim().toLowerCase()}`);
  // The template commitment a member's capability is armed against.
  const templateHash = await sha256(`vinct:template:pause-new-borrowing:v1`);

  const signature = await sendWithWallet(connection, wallet, [
    createCovenant(wallet.publicKey, {
      covenantId,
      circleEpoch: 1n,
      clusterGenesisHash,
      policyId,
      actionBundleTemplateHash: templateHash,
      requiredApprovals: draft.requiredApprovals,
      maximumRejections: draft.maximumRejections,
      responseWindowSlots: draft.responseWindowSlots,
      certificateLifetimeSlots: 200_000n,
      epochLifetimeSlots: 20_000_000n,
    }),
  ]);

  return { covenant: covenantAddress(wallet.publicKey, covenantId), signature, covenantId };
}

/**
 * Names a member. Signed by the steward.
 *
 * Naming is a proposal and not consent: the membership account exists after this and is not
 * ratified, and the covenant cannot arm until that protocol signs for itself.
 */
export async function addMember(
  connection: Connection,
  wallet: WalletState,
  covenant: PublicKey,
  protocol: PublicKey,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  return sendWithWallet(connection, wallet, [
    addCovenantMember(covenant, wallet.publicKey, protocol, 0, PublicKey.default),
  ]);
}

/** A protocol accepting its own membership. Only that protocol's key can send this. */
export async function ratifyOwnMembership(
  connection: Connection,
  wallet: WalletState,
  covenant: PublicKey,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  return sendWithWallet(connection, wallet, [ratifyCovenantMember(covenant, wallet.publicKey)]);
}

/**
 * A protocol arming its own adapter, then recording that on its membership.
 *
 * Two instructions in one transaction because they are one intent and both are signed by the
 * same key. Installing the capability is what bounds what may ever happen; the membership flag
 * is how the covenant knows it can arm.
 */
export async function armOwnAdapter(
  connection: Connection,
  wallet: WalletState,
  covenant: PublicKey,
  options: {
    /** The protocol's own account that the bounded action may touch, and nothing else. */
    protocolState: PublicKey;
    policyId: Uint8Array;
    memberSetHash: Uint8Array;
    clusterGenesisHash: Uint8Array;
    validFromSlot: bigint;
    expiresAtSlot: bigint;
  },
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");

  const capability = capabilityAddress(wallet.publicKey, covenant, options.policyId);
  const adapterSigner = adapterSignerAddress(capability);

  /*
   * The template this protocol is arming.
   *
   * It commits to the shape of the instruction rather than to any future transaction: the two
   * derived slots carry their role instead of an address, because a receipt's address depends
   * on an operation id that does not exist until an incident certifies. That is what lets a
   * protocol arm now and stay armed for every incident this covenant ever certifies. See
   * docs/decision-log.md D-0050.
   */
  const templateHash = actionTemplateHash([
    { kind: "certificate", isSigner: false, isWritable: false },
    { kind: "fixed", pubkey: capability, isSigner: false, isWritable: true },
    { kind: "fixed", pubkey: options.protocolState, isSigner: false, isWritable: true },
    { kind: "adapterReceipt", isSigner: false, isWritable: true },
    { kind: "fixed", pubkey: adapterSigner, isSigner: false, isWritable: false },
    { kind: "fixed", pubkey: MOCK_PROTOCOL_PROGRAM_ID, isSigner: false, isWritable: false },
  ]);

  const pauseDiscriminator = await anchorDiscriminator("global:pause_new_borrowing");
  const executeData = await anchorDiscriminator("global:execute_bounded_action");
  const dataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", executeData.slice().buffer as ArrayBuffer),
  );

  return sendWithWallet(connection, wallet, [
    installCapability(capability, wallet.publicKey, {
      protocolState: options.protocolState,
      coreProgram: CORE_PROGRAM_ID,
      adapterVersion: 1,
      clusterGenesisHash: options.clusterGenesisHash,
      covenant,
      circleEpoch: 1n,
      policyId: options.policyId,
      memberSetHash: options.memberSetHash,
      actionCategory: 0,
      targetProgram: MOCK_PROTOCOL_PROGRAM_ID,
      instructionDiscriminator: pauseDiscriminator,
      actionTemplateHash: templateHash,
      instructionDataHash: dataHash,
      // The ceiling this protocol places on itself. Pausing only, never unpausing, and no value
      // may move at all.
      maxEffect: { mayPause: true, mayUnpause: false, maxValueMoved: 0n },
      validFromSlot: options.validFromSlot,
      expiresAtSlot: options.expiresAtSlot,
    }),
    armCapability(capability, wallet.publicKey, 1),
    armCovenantMember(covenant, wallet.publicKey, 1),
  ]);
}

/** The first eight bytes of sha256 over an Anchor instruction name. */
async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  return new Uint8Array(digest).slice(0, 8);
}

/** A protocol suspending its own adapter. Refused for anybody else by the program. */
export async function suspendOwnAdapter(
  connection: Connection,
  wallet: WalletState,
  covenant: PublicKey,
  policyId: Uint8Array,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const capability = capabilityAddress(wallet.publicKey, covenant, policyId);
  return sendWithWallet(connection, wallet, [suspendCapability(capability, wallet.publicKey)]);
}

/**
 * The two covenant-level steps, which take no signature.
 *
 * Permissionless because every signature that mattered has already been collected. Anyone may
 * send them, and they refuse unless every member has in fact ratified and armed, so being
 * permissionless costs nothing and removes a place for somebody to sit on the result.
 */
export async function finalise(
  connection: Connection,
  wallet: WalletState,
  covenant: PublicKey,
  members: PublicKey[],
): Promise<{ ratified: string; armed: string }> {
  const ordered = [...members].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const memberships = ordered.map((protocol) => covenantMemberAddress(covenant, protocol));

  const ratified = await sendWithWallet(connection, wallet, [
    ratifyCovenant(covenant, memberships),
  ]);
  const armed = await sendWithWallet(connection, wallet, [armCovenant(covenant)]);
  return { ratified, armed };
}

/** What is outstanding, so the interface can say whose turn it is rather than guessing. */
export interface Readiness {
  protocol: PublicKey;
  ratified: boolean;
  armed: boolean;
  /** True when the connected wallet is the one this row is waiting for. */
  isYou: boolean;
}

export function describeReadiness(rows: Readiness[]): string {
  const ratified = rows.filter((row) => row.ratified).length;
  const armed = rows.filter((row) => row.armed).length;
  if (rows.length === 0) return "No members yet.";
  if (armed === rows.length) return "Every protocol has ratified and armed. The covenant is ready.";
  if (ratified === rows.length) return `${armed} of ${rows.length} adapters armed.`;
  return `${ratified} of ${rows.length} protocols have ratified.`;
}

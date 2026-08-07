/**
 * Phase 0 TypeScript compatibility probe.
 *
 * Type-level only. It imports every client surface VINCT depends on so that
 * `pnpm typecheck` fails if a pinned package stops exporting one of them. It
 * contains no VINCT product logic and performs no network calls.
 *
 * VINCT's TypeScript client stack is `@solana/web3.js` v1. `@solana/kit` is not
 * used anywhere; if kit interop is ever needed it stays behind this package.
 */

import type { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  ConnectionMagicRouter,
  DelegationStatus,
  delegationRecordPdaFromDelegatedAccount,
  getDelegationRecord,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { getDelegationStatus, sendMagicTransaction } from "magic-router-sdk";

/** Program IDs come from the SDK, never from a copied literal. */
export const PROGRAM_IDS = {
  delegation: DELEGATION_PROGRAM_ID,
  magic: MAGIC_PROGRAM_ID,
  magicContext: MAGIC_CONTEXT_ID,
} satisfies Record<string, PublicKey>;

/**
 * What the router's `getDelegationStatus` is typed to return in the pinned SDK.
 *
 * Observed live against `https://devnet-router.magicblock.app/` for an undelegated
 * account: `{"isDelegated": false}` only. The endpoint the ER lives on is NOT part
 * of that response for an undelegated account, and whether a delegated account's
 * response carries an `fqdn` is unverified. Until a delegated-account response is
 * captured on Devnet, VINCT must not assume `getDelegationStatus` alone resolves an
 * ER endpoint. See docs/decision-log.md.
 */
export type RouterDelegationStatus = Awaited<ReturnType<typeof getDelegationStatus>>;

// The routing table entry shape lives in ./routing.ts, alongside the resolver that uses it.

/**
 * Endpoint resolution contract. Phase 0 fixes the shape only; the implementation
 * lands with the first real delegated account. A regional endpoint is never a
 * constant in VINCT — it is always whatever the router advertises for the account.
 */
export interface ErEndpointResolver {
  resolveForAccount(account: PublicKey): Promise<{ fqdn: string; identity: string }>;
}

/** Compile-surface anchors. Never called; referenced so the imports cannot be dropped. */
export type RouterConnection = ConnectionMagicRouter;
export type SendMagicTransaction = typeof sendMagicTransaction;
export type GetDelegationRecord = typeof getDelegationRecord;
export type DelegationRecordPda = typeof delegationRecordPdaFromDelegatedAccount;
export type DelegationStatusEnum = DelegationStatus;

/** Guards against silently sending an ER transaction built on a base-layer blockhash. */
export interface RuntimeBoundTransaction {
  runtime: "base" | "er";
  transaction: Transaction;
  blockhashFrom: Connection;
}

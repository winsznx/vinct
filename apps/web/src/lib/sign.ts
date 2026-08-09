/**
 * Everything the browser signs, and the one rule it never breaks.
 *
 * No secret key exists in this application. Not in source, not in an environment variable, not
 * in storage of any kind. Every signature is produced inside the user's wallet, and what comes
 * back is a signature over a message or a transaction the user was shown first.
 *
 * That constraint is what makes the private flow safe to run in a browser. A page that held a
 * member's key so it could authenticate to a rollup would have moved that member's private
 * material outside the boundary the whole protocol exists to hold, and no amount of on-chain
 * correctness would fix it.
 *
 * Two things get signed here.
 *
 * A challenge, so a private rollup learns which key is asking. The rollup issues bytes, the
 * wallet signs them, and a short-lived token comes back on the connection URL. The token proves
 * identity; whether that identity may read a given account is the permission's decision,
 * separately and afterwards.
 *
 * A transaction, when a covenant or an incident needs one. The wallet shows the user what they
 * are approving and returns it signed.
 */

import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

import type { WalletState } from "./wallet";

/** How long before expiry a session is treated as spent, so a signature never lands stale. */
const RENEW_MARGIN_MS = 60_000;

export interface RollupSession {
  connection: Connection;
  endpoint: string;
  expiresAt: number;
  /** Safe to display and to record: the endpoint with the credential removed. */
  redactedUrl: string;
}

/**
 * In-memory only, keyed by endpoint and wallet.
 *
 * Deliberately not `localStorage`. A session token is a bearer credential for a member's private
 * view, and persisting one would leave it readable by anything else running on this origin and
 * alive long after the tab closed. Losing it on refresh costs one wallet prompt.
 */
const sessions = new Map<string, RollupSession>();

/**
 * Authenticates the connected wallet against a private rollup.
 *
 * Returns a connection carrying the session. The token is never logged, never persisted, and
 * never included in anything this app writes down.
 */
export async function authenticateWallet(
  endpoint: string,
  wallet: WalletState,
): Promise<RollupSession> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");

  const base = endpoint.replace(/\/$/, "");
  const key = `${base}:${wallet.publicKey.toBase58()}`;

  const existing = sessions.get(key);
  if (existing && existing.expiresAt - RENEW_MARGIN_MS > Date.now()) return existing;

  const { token, expiresAt } = await getAuthToken(base, wallet.publicKey, (message) =>
    wallet.signMessage(message),
  );

  const session: RollupSession = {
    connection: new Connection(`${base}/?token=${token}`, "confirmed"),
    endpoint: base,
    expiresAt,
    redactedUrl: `${base}/?token=<redacted>`,
  };
  sessions.set(key, session);
  return session;
}

/** Drops every session. Called on disconnect so a token cannot outlive the wallet that made it. */
export function clearSessions(): void {
  sessions.clear();
}

export interface SendResult {
  signature: string;
  /** What the signature actually establishes, which for a rollup is less than people assume. */
  meaning: string;
}

/**
 * Builds, signs, and sends one transaction through the connected wallet.
 *
 * Confirmation is polled rather than subscribed. Several hosted RPC tiers serve no websockets,
 * and `signatureSubscribe` failing there looks like a thirty-second timeout claiming it is
 * unknown whether a transaction succeeded, on one that landed.
 */
export async function sendWithWallet(
  connection: Connection,
  wallet: WalletState,
  instructions: TransactionInstruction[],
  options: { skipPreflight?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");

  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const signed = await wallet.signTransaction(transaction);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    // A rollup skips preflight because it cannot always simulate its own scheduling CPI.
    skipPreflight: options.skipPreflight ?? false,
  });

  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (
      status &&
      (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
    ) {
      return signature;
    }
    if (Date.now() > deadline) throw new Error("The transaction was not confirmed in time.");
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

/**
 * Turns a program error into something a person can act on.
 *
 * An Anchor custom error arrives as a number. Without the mapping a user sees
 * `{"InstructionError":[0,{"Custom":6014}]}` and has no idea whether they did something wrong or
 * the product is broken.
 */
export function explainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/User rejected|rejected the request|declined/i.test(message)) {
    return "You declined the signature in your wallet. Nothing was sent.";
  }
  if (/insufficient (lamports|funds)/i.test(message)) {
    return "This wallet does not have enough SOL on Devnet to pay for the transaction.";
  }
  if (/blockhash not found|block height exceeded/i.test(message)) {
    return "The transaction expired before it landed. Try again.";
  }
  if (/signMessage|cannot sign messages/i.test(message)) {
    return "This wallet cannot sign messages, which a private rollup requires to identify you.";
  }
  if (/401|Unauthorized|Missing token/i.test(message)) {
    return "The rollup did not accept this session. Reconnect your wallet and try again.";
  }

  const custom = /"Custom":\s*(\d+)/.exec(message);
  if (custom) {
    return `The program refused this: error ${custom[1]}. Nothing changed on chain.`;
  }
  return message;
}

/** A public key, or null when the text is not one. Never throws at a caller mid-render. */
export function parsePublicKey(text: string): PublicKey | null {
  const trimmed = text.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return null;
  try {
    return new PublicKey(trimmed);
  } catch {
    return null;
  }
}

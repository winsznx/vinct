/**
 * Signed client authentication for a private ephemeral rollup.
 *
 * A private rollup will not accept a transaction, or answer a read, from an anonymous
 * caller. It issues a challenge, the wallet signs it, and the rollup returns a session
 * token that rides on the RPC URL as a query parameter.
 *
 * Authentication and authorization are separate here, deliberately. A token proves which
 * key is asking. Whether that key may see or touch a given account is the permission's
 * decision, made afterwards. An outsider can hold a perfectly valid token and still be
 * refused, which is the case the Phase 4 run exercises.
 *
 * The token is a bearer credential for a wallet's private view. It is never logged, never
 * written to an artifact, and never returned from any function that produces evidence. The
 * only thing that leaves this module is a `Connection` that happens to carry it.
 */

import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

export interface AuthenticatedEndpoint {
  connection: Connection;
  publicKey: PublicKey;
  expiresAt: number;
  /** The endpoint without the credential, safe to print and to write to an artifact. */
  redactedUrl: string;
}

/**
 * Authenticates one keypair against a rollup and returns a connection that carries the
 * session.
 *
 * `endpoint` is whatever live routing resolved. Nothing in here parses or special-cases a
 * hostname.
 */
export async function authenticate(
  endpoint: string,
  keypair: Keypair,
): Promise<AuthenticatedEndpoint> {
  const base = endpoint.replace(/\/$/, "");
  const { token, expiresAt } = await getAuthToken(base, keypair.publicKey, async (message) =>
    nacl.sign.detached(message, keypair.secretKey),
  );
  return {
    connection: new Connection(`${base}/?token=${token}`, "confirmed"),
    publicKey: keypair.publicKey,
    expiresAt,
    redactedUrl: `${base}/?token=<redacted>`,
  };
}

/**
 * Authenticates several keypairs against the same rollup.
 *
 * Each participant gets their own session. Sharing one is the shortcut that turns a
 * per-member boundary into a single shared identity, and the run would then prove nothing
 * about which member could do what.
 */
export async function authenticateAll(
  endpoint: string,
  keypairs: Keypair[],
): Promise<Map<string, AuthenticatedEndpoint>> {
  const sessions = new Map<string, AuthenticatedEndpoint>();
  for (const keypair of keypairs) {
    sessions.set(keypair.publicKey.toBase58(), await authenticate(endpoint, keypair));
  }
  return sessions;
}

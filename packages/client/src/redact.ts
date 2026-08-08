/**
 * An endpoint, safe to write down.
 *
 * Every proof run records the endpoints it used, which is right: an artifact that does not name
 * the cluster it was taken against is not evidence of anything. But a paid RPC carries its
 * credential in the path or the query string, and committing an artifact would publish it.
 *
 * So the host is kept and the credential is not. `https://solana-devnet.g.alchemy.com/v2/KEY`
 * becomes `https://solana-devnet.g.alchemy.com/v2/<redacted>`, which still identifies the
 * provider and the network while carrying nothing anyone can spend.
 *
 * This is applied at the point of writing rather than at the point of reading. A run needs the
 * real URL; only the record needs the redacted one.
 */

/**
 * Path segments that are names rather than secrets.
 *
 * Everything else in a path is treated as a credential, because guessing wrong in the other
 * direction publishes a key.
 */
const KNOWN_SEGMENTS = new Set(["v1", "v2", "rpc", "devnet", "mainnet", "testnet", "solana"]);

/** Query parameters whose values are credentials wherever they appear. */
const SECRET_PARAMS = ["api-key", "api_key", "apikey", "key", "token", "access-token", "auth"];

export function redactEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }

  // A userinfo section is always a credential.
  url.username = "";
  url.password = "";

  // Allowlist, not denylist. Anything not recognised as a route name is redacted, which
  // occasionally hides something harmless and never publishes something that is not. Guessing
  // wrong in the other direction costs a credential.
  url.pathname = url.pathname
    .split("/")
    .map((segment) =>
      segment === "" || KNOWN_SEGMENTS.has(segment.toLowerCase()) ? segment : "<redacted>",
    )
    .join("/");

  for (const param of SECRET_PARAMS) {
    if (url.searchParams.has(param)) url.searchParams.set(param, "<redacted>");
  }

  // `URL.toString` percent-encodes the marker into `%3Credacted%3E`, which is correct and
  // unreadable. The marker is ours and contains nothing to escape.
  return url.toString().replace(/%3Credacted%3E/gi, "<redacted>");
}

/** Redacts every value of an endpoint record, leaving the keys alone. */
export function redactEndpoints<T extends Record<string, string | null | undefined>>(
  endpoints: T,
): Record<keyof T, string | null> {
  const out = {} as Record<keyof T, string | null>;
  for (const key of Object.keys(endpoints) as (keyof T)[]) {
    const value = endpoints[key];
    out[key] = typeof value === "string" ? redactEndpoint(value) : null;
  }
  return out;
}

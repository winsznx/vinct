/**
 * The only server VINCT has, and the least it could be.
 *
 * It does two things: serve the built site, and forward Solana JSON-RPC reads to an endpoint
 * whose credential must not be in a public bundle. That is the whole reason it exists. A paid
 * RPC key shipped to the browser is a key anyone can spend, and the alternative, a public
 * endpoint, is slow enough to make the console feel broken.
 *
 * What it deliberately is not:
 *
 * It is not an authority. It cannot sign anything, holds no key material, and every transaction
 * is built and signed in the user's wallet.
 *
 * It is not a source of truth. It forwards a request and returns the answer. If it disappeared,
 * the app would still work against any RPC the reader names with `?base=`, which is exactly what
 * the tests do.
 *
 * It never sees private incident material. A member's claim and ballot live inside the private
 * rollup and are read over an authenticated connection straight from the browser to MagicBlock.
 * Nothing on that path passes through here.
 *
 * It stores nothing. No KV, no D1, no cache of chain state. See CLAUDE.md on the database and
 * Cloudflare policy.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** A Solana Devnet RPC URL, set with `wrangler secret put`. Never in the repository. */
  SOLANA_RPC?: string;
  /** Where to send calls the primary endpoint declines. Public, so no secret is involved. */
  FALLBACK_RPC?: string;
}

/** Used when the primary declines a method, which several paid tiers do for account scans. */
const DEFAULT_FALLBACK = "https://api.devnet.solana.com";

/**
 * Methods a paid tier commonly refuses.
 *
 * `getProgramAccounts` is the one that matters: it is how covenant membership and capability
 * discovery work, and a tier that declines it makes the console look empty rather than slow. A
 * refusal is answered by asking the public endpoint instead, which is slower and always allowed.
 * Reporting the refusal as "no covenants" would be telling somebody their memberships do not
 * exist because of a billing plan.
 */
const FALLBACK_METHODS = new Set(["getProgramAccounts"]);

/** Only the methods the app actually calls. An open proxy is somebody else's rate limit. */
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getGenesisHash",
  "getSlot",
  "getHealth",
  "getTransaction",
  "getSignaturesForAddress",
  "simulateTransaction",
  "sendTransaction",
  "getBalance",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "getVersion",
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/rpc") {
      return proxyRpc(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function proxyRpc(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return json({ error: "POST a JSON-RPC body" }, 405);
  }
  if (!env.SOLANA_RPC) {
    // Says what is wrong rather than failing opaquely, because the fix is a deploy step.
    return json({ error: "This deployment has no SOLANA_RPC configured." }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body was not JSON." }, 400);
  }

  // A batch is a legitimate shape: the web3.js client coalesces reads into one.
  const calls = Array.isArray(body) ? body : [body];
  for (const call of calls) {
    const method = (call as { method?: unknown }).method;
    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return json({ error: `Method not proxied: ${String(method)}` }, 403);
    }
  }

  const fallback = env.FALLBACK_RPC ?? DEFAULT_FALLBACK;
  const needsFallback = calls.some((call) =>
    FALLBACK_METHODS.has(String((call as { method?: unknown }).method)),
  );

  // Known-declined methods skip the primary entirely rather than paying a round trip to be
  // refused. Everything else tries the fast endpoint first.
  const primary = needsFallback ? fallback : env.SOLANA_RPC;
  const upstream = await fetch(primary, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();

  // A tier can decline something not on the list above. One retry against the public endpoint
  // costs a little latency and turns an opaque failure into an answer.
  if (!needsFallback && /not available on the .* tier|Unsupported method/i.test(text)) {
    const retried = await fetch(fallback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return new Response(retried.body, {
      status: retried.status,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  return new Response(text, {
    status: upstream.status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, solana-client",
  };
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

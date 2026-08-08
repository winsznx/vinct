/**
 * Where the app reads from, and the rule that it only ever reads.
 *
 * Endpoints come from the URL or from build-time config, never from a server this app talks
 * to. There is no backend: a page that could ask a service what a settlement means would make
 * that service the authority, and the whole point of the settlement model is that the answer
 * comes from base-layer accounts.
 *
 * Nothing here is a secret. Every value is a public RPC address, which is why it is safe to
 * put them in a query string and why the proof path works with no wallet and no login.
 */

export interface Endpoints {
  base: string;
  /** The rollup. Resolved through the router in production; overridable for the local stack. */
  ephemeral: string | null;
  router: string | null;
  label: string;
}

const LOCAL: Endpoints = {
  base: "http://127.0.0.1:8899",
  ephemeral: "http://127.0.0.1:7799",
  router: null,
  label: "local stack",
};

const DEVNET: Endpoints = {
  base: "https://api.devnet.solana.com",
  ephemeral: null,
  router: "https://devnet-router.magicblock.app",
  label: "devnet",
};

/**
 * Reads endpoints from the query string, falling back to the local stack.
 *
 * `?network=devnet` switches the whole app. Individual endpoints can be overridden for a
 * proof run against a specific validator, which is what a judge needs when the artifact they
 * are checking names one.
 */
export function readEndpoints(search: string): Endpoints {
  const params = new URLSearchParams(search);
  const network = params.get("network");
  const base = network === "devnet" ? DEVNET : LOCAL;
  return {
    base: params.get("base") ?? base.base,
    ephemeral: params.get("er") ?? base.ephemeral,
    router: params.get("router") ?? base.router,
    label: params.get("base") || params.get("er") ? `${base.label} (overridden)` : base.label,
  };
}

/**
 * The one storage key this app is allowed to write.
 *
 * It holds a covenant address so a reload lands where the user was. Addresses are public: they
 * are visible on chain to anyone who looks. Nothing else is ever persisted, and
 * `tests/web/privacy.spec.ts` walks the whole app asserting that.
 *
 * A claim, a decision, a nonce, or a signature must never reach storage. They are private to a
 * member set inside a rollup, and a browser that keeps a copy has moved them outside it.
 */
export const STORAGE_KEY = "vinct.covenant";

export function rememberCovenant(address: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, address);
  } catch {
    // A browser with storage disabled is fine. Nothing here is required to function.
  }
}

export function recallCovenant(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

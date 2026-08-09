/**
 * Says out loud what an empty local console actually means.
 *
 * With `VITE_SOLANA_RPC` unset the app reads from `/rpc` on its own origin, which is correct in
 * production and is the Worker proxy holding the upstream credential. `vite` serves no such
 * route, so locally every read 404s. The pages still render and the console reports nothing:
 * a configuration mistake wearing the costume of an empty chain.
 *
 * Reached only through a dynamic import inside `if (import.meta.env.DEV)`, which is replaced
 * with `false` at build time and eliminated with the branch. That is the reason this is a
 * plain DOM node rather than a component: a production build then has no trace of it, not even
 * a null child in the tree, and the deployed bundle stays byte-for-byte what it was. Verified
 * by rebuilding and comparing asset hashes against the live deployment.
 */

const ELEMENT_ID = "vinct-dev-config-notice";

const MESSAGE =
  "VINCT: VITE_SOLANA_RPC is not set, so Solana reads are going to /rpc on this dev server and " +
  "returning 404. That route only exists on the deployed Worker. Run " +
  "`cp apps/web/.env.example apps/web/.env.development.local` and restart the dev server.";

export function mountDevConfigNotice(): void {
  if (import.meta.env.VITE_SOLANA_RPC) return;
  if (document.getElementById(ELEMENT_ID)) return;

  console.warn(MESSAGE);

  const notice = document.createElement("aside");
  notice.id = ELEMENT_ID;
  notice.setAttribute("role", "alert");
  notice.style.cssText = [
    "position:fixed",
    "inset-inline:0",
    "bottom:0",
    "z-index:9999",
    "padding:var(--s3) var(--s4)",
    "background:var(--attention-bg)",
    "border-top:1px solid var(--line-violet)",
    "backdrop-filter:blur(8px)",
    "color:var(--text)",
    "font:var(--t-small)/1.5 var(--font-mono)",
  ].join(";");
  notice.innerHTML =
    '<strong style="color:var(--attention)">Local config missing.</strong> ' +
    "<code>VITE_SOLANA_RPC</code> is unset, so chain reads are hitting <code>/rpc</code> on this " +
    "dev server and returning 404. That route exists only on the deployed Worker, and every page " +
    "will look empty rather than broken. " +
    "<code>cp apps/web/.env.example apps/web/.env.development.local</code>, then restart " +
    "<code>pnpm web</code>.";

  document.body.append(notice);
}

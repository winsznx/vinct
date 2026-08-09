# Deployment

The app is static files plus one narrow RPC proxy on Cloudflare Workers. There is no database and
no server that holds authority.

Live: <https://vinct.timjosh507.workers.dev>

## What is deployed

| Piece | Where | Holds |
| --- | --- | --- |
| Built React app | Cloudflare Workers assets | nothing |
| `/rpc` proxy | the same Worker | one secret: an RPC URL |
| Programs | Solana Devnet | all protocol truth |
| Private incident state | MagicBlock rollup | claims and ballots |

## Why there is a proxy at all

A paid RPC endpoint carries its credential in the URL, and anything in a browser bundle is
public. The free public endpoint is slow enough to make the console feel broken. So the
credential sits in a Worker secret and the browser calls `/rpc` on its own origin.

The proxy forwards a fixed allowlist of read methods and refuses everything else. It cannot sign,
stores nothing, and never sees private incident material: that path runs from the browser
straight to MagicBlock over a wallet-authenticated connection.

If the Worker vanished, the app still works against any RPC a reader names with `?base=`, which
is exactly what the local test run does.

### One asymmetry worth knowing

Account scans go **direct from the browser** to the public Solana endpoint, not through the
proxy. Paid tiers commonly decline `getProgramAccounts`, and the public endpoint blocks the
datacentre addresses a Worker calls from. A browser is not blocked. So `Network.scan` is a
separate endpoint from `Network.base`, and both are visible in `apps/web/src/lib/network.ts`.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `SOLANA_RPC` | Worker secret | upstream for the proxy |
| `FALLBACK_RPC` | Worker var, optional | used when the primary declines a method |
| `VITE_SOLANA_RPC` | build time, optional | overrides the proxy default |
| `VITE_SOLANA_SCAN_RPC` | build time, optional | overrides the scan endpoint |
| `VITE_MAGICBLOCK_ROUTER` | build time, optional | router for rollup resolution |

No regional rollup is ever hardcoded. `resolveRuntime` asks the router what exists and refuses
to guess when the router and the chain disagree.

The build fingerprint is computed from `programs/vinct-core/src` at build time and inlined, so
the app can tell whether a rollup is executing the build it was compiled against.

## Deploying

```bash
pnpm install --frozen-lockfile
pnpm optimize-art                       # only when source art changed
pnpm --filter @vinct/web build
cd apps/web
npx wrangler secret put SOLANA_RPC      # once
npx wrangler deploy --dry-run           # inspect bindings
npx wrangler deploy
```

Run the whole local gate first. `docs/VERIFICATION.md` lists it.

## Verifying a deployment

```bash
VINCT_WEB_URL=https://vinct.timjosh507.workers.dev \
VINCT_COVENANT=<covenant> VINCT_OPERATION=<operation> \
  pnpm exec playwright test
```

The suite is written against behaviour rather than a dev server, so the only thing that changes
is the origin. A suite that can only pass locally proves the build works on the machine that
made it.

## Programs

Deploying a program this size needs a dedicated RPC. Three attempts against the public endpoint
failed three different ways, and none of the errors names the real cause. The table is in
`docs/runbooks/devnet-proof-runs.md`, along with how to reclaim the orphaned buffer each
attempt leaves behind.

```bash
solana program deploy target/deploy/vinct_core.so \
  --program-id .toolchain/program-keys/vinct_core-keypair.json \
  -u "$VINCT_BASE_RPC" -k .toolchain/keys/devnet-deployer.json --use-rpc
```

## What is deliberately absent

No database. Protocol truth is on Solana and MagicBlock, and a cache would be a second thing to
disagree with them. If an off-chain store is ever justified it is Supabase Postgres, holding only
rebuildable chain-derived rows.

No analytics, no CDN scripts, no third-party origins. A browser test asserts the app contacts
nothing the reader did not choose.

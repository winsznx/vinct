/**
 * Endpoint resolution, including the case where the router and the chain disagree.
 *
 * A stub router stands in for the real one so every branch is reachable without a network. The
 * branch that matters most is the mismatch: the router answers, publishes a routing table, and
 * that table does not list the validator the account is actually delegated to. Resolving
 * anything at all there would send delegated state to a rollup the account is not delegated
 * to, so the resolver returns no endpoint and says why.
 *
 *   pnpm exec tsx --test tests/program/routing.test.ts
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  resolveEphemeralEndpoint,
  validatorFromDelegationRecord,
} from "../../packages/client/src/index.js";

const DELEGATED = Keypair.generate().publicKey;
const RECORD = Keypair.generate().publicKey;
const VALIDATOR = Keypair.generate().publicKey;
const OTHER_VALIDATOR = Keypair.generate().publicKey;
const CONFIGURED = "http://127.0.0.1:7799";

/** A delegation record: an 8-byte discriminator, then the validator authority. */
function delegationRecord(validator: PublicKey): Buffer {
  return Buffer.concat([Buffer.alloc(8, 1), Buffer.from(validator.toBytes()), Buffer.alloc(32)]);
}

/**
 * A base connection that answers for exactly one account.
 *
 * Only `getAccountInfo` is reached, so the rest of the interface is deliberately absent rather
 * than stubbed into something that looks usable.
 */
function baseConnection(record: Buffer | null) {
  return {
    getAccountInfo: async () => (record === null ? null : { data: record }),
  } as unknown as Parameters<typeof resolveEphemeralEndpoint>[0]["baseConnection"];
}

const servers: Server[] = [];

/** Starts a stub router that answers the two methods the resolver calls. */
async function stubRouter(responses: Record<string, unknown>): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { method, id } = JSON.parse(body) as { method: string; id: number };
      const result = responses[method];
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }
            : { jsonrpc: "2.0", id, result },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

test("the validator identity is read from the delegation record", () => {
  const parsed = validatorFromDelegationRecord(delegationRecord(VALIDATOR));
  assert.ok(parsed);
  assert.ok(parsed.equals(VALIDATOR));
});

test("a record too short to hold an identity yields none", () => {
  assert.equal(validatorFromDelegationRecord(Buffer.alloc(16)), null);
});

test("an fqdn on getDelegationStatus is used directly", async () => {
  const router = await stubRouter({
    getDelegationStatus: { isDelegated: true, fqdn: "https://er.example" },
  });
  const resolved = await resolveEphemeralEndpoint({
    router,
    baseConnection: baseConnection(delegationRecord(VALIDATOR)),
    delegatedAccount: DELEGATED,
    delegationRecord: RECORD,
    configuredEndpoint: CONFIGURED,
  });
  assert.equal(resolved.source, "getDelegationStatus.fqdn");
  assert.equal(resolved.endpoint, "https://er.example");
});

test("without an fqdn, the routing table is matched on the record's validator", async () => {
  const router = await stubRouter({
    getDelegationStatus: { isDelegated: true },
    getRoutes: [
      { identity: OTHER_VALIDATOR.toBase58(), fqdn: "https://wrong.example" },
      { identity: VALIDATOR.toBase58(), fqdn: "https://right.example" },
    ],
  });
  const resolved = await resolveEphemeralEndpoint({
    router,
    baseConnection: baseConnection(delegationRecord(VALIDATOR)),
    delegatedAccount: DELEGATED,
    delegationRecord: RECORD,
    configuredEndpoint: CONFIGURED,
  });
  assert.equal(resolved.source, "getRoutes+delegationRecord");
  assert.equal(resolved.endpoint, "https://right.example");
  assert.equal(resolved.evidence.validatorIdentity, VALIDATOR.toBase58());
});

/**
 * The mismatch. The router is up, it published routes, and none of them is this account's
 * validator.
 *
 * A configured endpoint is supplied and must not be used. Substituting it would put delegated
 * private state on a rollup the account is not delegated to, which is the same failure class as
 * D-0041 arriving from the other direction: there a stranger chose the rollup, here a stale
 * routing table would.
 */
test("a router that does not list the account's validator resolves nothing", async () => {
  const router = await stubRouter({
    getDelegationStatus: { isDelegated: true },
    getRoutes: [{ identity: OTHER_VALIDATOR.toBase58(), fqdn: "https://wrong.example" }],
  });
  const resolved = await resolveEphemeralEndpoint({
    router,
    baseConnection: baseConnection(delegationRecord(VALIDATOR)),
    delegatedAccount: DELEGATED,
    delegationRecord: RECORD,
    configuredEndpoint: CONFIGURED,
  });

  assert.equal(resolved.source, "router-mismatch");
  assert.equal(resolved.endpoint, null, "a mismatched router still produced an endpoint");
  assert.notEqual(
    resolved.endpoint,
    CONFIGURED,
    "the configured endpoint was substituted for a router mismatch",
  );
  assert.match(resolved.evidence.note, /mismatch/i);
});

/**
 * A router that is down is not a router that disagrees.
 *
 * With no routing table there is nothing to contradict, so the configured endpoint is the
 * right answer and the result records that the caller supplied it.
 */
test("an unreachable router falls back to the configured endpoint and says so", async () => {
  const resolved = await resolveEphemeralEndpoint({
    // Port 1 refuses connections; the resolver's fetch wrapper turns that into a null result.
    router: "http://127.0.0.1:1",
    baseConnection: baseConnection(delegationRecord(VALIDATOR)),
    delegatedAccount: DELEGATED,
    delegationRecord: RECORD,
    configuredEndpoint: CONFIGURED,
  });
  assert.equal(resolved.source, "configured");
  assert.equal(resolved.endpoint, CONFIGURED);
});

test("with no router and no configured endpoint, nothing is resolved", async () => {
  const resolved = await resolveEphemeralEndpoint({
    router: null,
    baseConnection: baseConnection(delegationRecord(VALIDATOR)),
    delegatedAccount: DELEGATED,
    delegationRecord: RECORD,
  });
  assert.equal(resolved.source, "unresolved");
  assert.equal(resolved.endpoint, null);
});

/**
 * A router with an empty routing table cannot contradict anything either.
 *
 * The distinction is deliberate: "the router lists routes and yours is not among them" is a
 * mismatch, while "the router has no routes to report" is an absence of evidence and leaves the
 * configured endpoint as the honest fallback.
 */
test("an empty routing table is an absence of evidence, not a mismatch", async () => {
  const router = await stubRouter({ getDelegationStatus: { isDelegated: true }, getRoutes: [] });
  const resolved = await resolveEphemeralEndpoint({
    router,
    baseConnection: baseConnection(delegationRecord(VALIDATOR)),
    delegatedAccount: DELEGATED,
    delegationRecord: RECORD,
    configuredEndpoint: CONFIGURED,
  });
  assert.equal(resolved.source, "configured");
});

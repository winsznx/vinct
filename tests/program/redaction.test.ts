/**
 * An endpoint written into an artifact must not carry a credential.
 *
 * Every proof run records the cluster it ran against, which is right: an artifact that does not
 * name its cluster is not evidence. A paid RPC puts its key in the path or the query string, so
 * recording the URL verbatim publishes the key the moment the artifact is committed.
 *
 * The rule is an allowlist. A path segment is kept only when it is a recognised route name, and
 * everything else is redacted. That occasionally hides something harmless. Guessing wrong the
 * other way costs a credential, and this test is written around cases that would.
 *
 *   pnpm exec tsx --test tests/program/redaction.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { redactEndpoint, redactEndpoints } from "../../packages/client/src/index.js";

/** Anything that could plausibly be a key, in the shapes providers actually use. */
const SECRETS = [
  "alch_Cgs3rFmUoZ_dGilpMmU8D",
  "1f8a9c0b-2d3e-4f50-a617-829b3c4d5e6f",
  "sk_live_abcdefghijklmnop",
  "AbCdEf0123456789",
];

test("a key in the path is removed and the host is kept", () => {
  for (const secret of SECRETS) {
    const redacted = redactEndpoint(`https://solana-devnet.g.alchemy.com/v2/${secret}`);
    assert.ok(!redacted.includes(secret), `the key survived: ${redacted}`);
    assert.ok(redacted.includes("solana-devnet.g.alchemy.com"), "the host was lost");
    assert.ok(redacted.includes("<redacted>"), "nothing marks where the key was");
  }
});

test("a key in the query string is removed", () => {
  for (const param of ["api-key", "api_key", "apikey", "key", "token", "auth"]) {
    const redacted = redactEndpoint(`https://rpc.example.com/?${param}=${SECRETS[0]}`);
    assert.ok(!redacted.includes(SECRETS[0]!), `${param} survived: ${redacted}`);
  }
});

test("a key in the userinfo is removed", () => {
  const redacted = redactEndpoint(`https://user:${SECRETS[0]}@rpc.example.com/`);
  assert.ok(!redacted.includes(SECRETS[0]!), redacted);
  assert.ok(!redacted.includes("user:"), redacted);
});

test("an endpoint with no credential is left recognisable", () => {
  assert.equal(redactEndpoint("http://127.0.0.1:8899/"), "http://127.0.0.1:8899/");
  assert.equal(redactEndpoint("https://api.devnet.solana.com/"), "https://api.devnet.solana.com/");
  // The provider and the network survive, which is what makes the artifact useful.
  const helius = redactEndpoint("https://devnet.helius-rpc.com/?api-key=secretsecret");
  assert.ok(helius.includes("devnet.helius-rpc.com"));
  assert.ok(!helius.includes("secretsecret"));
});

test("a record of endpoints is redacted value by value", () => {
  const redacted = redactEndpoints({
    base: `https://solana-devnet.g.alchemy.com/v2/${SECRETS[0]}`,
    er: "https://devnet-tee.magicblock.app/",
    router: null,
  });
  assert.ok(!JSON.stringify(redacted).includes(SECRETS[0]!));
  assert.equal(redacted.er, "https://devnet-tee.magicblock.app/");
  assert.equal(redacted.router, null);
  // The keys are structure, not data, and must survive.
  assert.deepEqual(Object.keys(redacted).sort(), ["base", "er", "router"]);
});

test("something that is not a URL is returned unchanged rather than mangled", () => {
  assert.equal(redactEndpoint("not a url"), "not a url");
  assert.equal(redactEndpoint(""), "");
});

/**
 * The property that matters, stated directly.
 *
 * Whatever the shape of the URL, no substring of the credential may survive. Checking for the
 * whole key would pass on a redactor that truncated it.
 */
test("no fragment of a key survives any shape of URL", () => {
  const secret = "alch_Cgs3rFmUoZ_dGilpMmU8D";
  const shapes = [
    `https://host.example/v2/${secret}`,
    `https://host.example/${secret}/rpc`,
    `https://host.example/rpc/${secret}?x=1`,
    `https://${secret}@host.example/`,
    `https://host.example/?api-key=${secret}`,
  ];
  for (const shape of shapes) {
    const redacted = redactEndpoint(shape);
    for (let length = 8; length <= secret.length; length += 1) {
      const fragment = secret.slice(0, length);
      assert.ok(!redacted.includes(fragment), `"${fragment}" survived in ${redacted}`);
    }
  }
});

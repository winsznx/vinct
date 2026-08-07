/**
 * Proves the canonical-vector verifier can fail.
 *
 * A parity checker that passes is only meaningful if it is capable of failing. Each case
 * here tampers with one thing and asserts the verifier reports it. Without these, a
 * verifier that returned an empty failure list unconditionally would look identical to a
 * correct one.
 *
 *   pnpm exec tsx --test tests/program/verifier-parity.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BorshReader,
  BorshWriter,
  decodeActionBundle,
  domain,
  encodeActionBundle,
  fromHex,
  loadVectors,
  operationId,
  sha256,
  templateRoundTrips,
  toHex,
  verifyVectors,
  type CanonicalVectors,
} from "../../packages/verifier/src/index.js";

function clone(): CanonicalVectors {
  return JSON.parse(JSON.stringify(loadVectors())) as CanonicalVectors;
}

test("the committed vectors verify cleanly", () => {
  const failures = verifyVectors(loadVectors());
  assert.deepEqual(failures, [], "committed vectors disagree with the TypeScript encoder");
  assert.ok(templateRoundTrips(loadVectors()));
});

test("a flipped digest is caught", () => {
  const vectors = clone();
  vectors.action_bundle.sha256 = "00".repeat(32);
  const failures = verifyVectors(vectors);
  assert.ok(
    failures.some((f) => f.entry === "action_bundle_v1" && f.check === "sha256(preimage)"),
    "a wrong digest was not reported",
  );
});

test("a tampered preimage is caught", () => {
  const vectors = clone();
  const bytes = fromHex(vectors.action_bundle.borsh_hex);
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0x01;
  vectors.action_bundle.borsh_hex = toHex(bytes);
  const failures = verifyVectors(vectors);
  assert.ok(failures.length > 0, "a tampered preimage was not reported");
});

test("a structured field that disagrees with the preimage is caught", () => {
  // The check that actually exercises the independent encoder: the preimage and digest
  // stay internally consistent, but one structured field no longer describes them.
  const vectors = clone();
  const action = vectors.action_bundle.fields.actions as Record<string, unknown>[];
  const first = action[0] as Record<string, unknown>;
  first.adapter_version = (first.adapter_version as number) + 1;

  const failures = verifyVectors(vectors);
  assert.ok(
    failures.some((f) => f.check === "independent encoding"),
    "a field/preimage disagreement was not reported",
  );
});

test("swapped account metas in the structured fields are caught", () => {
  const vectors = clone();
  const actions = vectors.action_bundle.fields.actions as Record<string, unknown>[];
  const metas = (actions[0] as Record<string, unknown>).account_metas as unknown[];
  const swapped = metas[1];
  metas[1] = metas[2];
  metas[2] = swapped;

  const failures = verifyVectors(vectors);
  assert.ok(
    failures.some((f) => f.check === "independent encoding"),
    "reordered account metas produced identical bytes",
  );
});

test("a mutation that does not change the digest is caught", () => {
  const vectors = clone();
  const mutation = vectors.action_bundle_mutations.find((m) => !m.rejected);
  assert.ok(mutation, "no accepted mutation in the vectors");
  mutation.borsh_hex = vectors.action_bundle.borsh_hex;
  mutation.sha256 = vectors.action_bundle.sha256;

  const failures = verifyVectors(vectors);
  assert.ok(
    failures.some((f) => f.check === "changes the digest"),
    "a no-op mutation was accepted",
  );
});

test("a recovery id equal to the original operation is caught", () => {
  const vectors = clone();
  vectors.recovery_operation_id.sha256 = vectors.operation_id.sha256;
  const failures = verifyVectors(vectors);
  assert.ok(
    failures.some((f) => f.check === "differs from the original operation"),
    "a recovery reusing the original operation id was accepted",
  );
});

test("a wrong domain separator is caught", () => {
  const vectors = clone();
  const record = vectors.domains[0];
  assert.ok(record);
  record.sha256 = "ff".repeat(32);
  const failures = verifyVectors(vectors);
  assert.ok(
    failures.some((f) => f.check === "sha256(label)"),
    "a wrong domain separator was accepted",
  );
});

test("borsh rejects trailing bytes", () => {
  const vectors = loadVectors();
  const bytes = fromHex(vectors.action_bundle.borsh_hex);
  const extended = new Uint8Array(bytes.length + 1);
  extended.set(bytes);
  assert.throws(() => decodeActionBundle(extended), /trailing bytes/);
});

test("borsh rejects a truncated encoding", () => {
  const vectors = loadVectors();
  const bytes = fromHex(vectors.action_bundle.borsh_hex);
  assert.throws(() => decodeActionBundle(bytes.slice(0, bytes.length - 1)));
});

test("borsh rejects a non-canonical bool byte", () => {
  const reader = new BorshReader(Uint8Array.of(2));
  assert.throws(() => reader.bool(), /invalid bool byte/);
});

test("borsh integer widths are little endian", () => {
  assert.equal(toHex(new BorshWriter().u16(0x0102).finish()), "0201");
  assert.equal(toHex(new BorshWriter().u32(0x01020304).finish()), "04030201");
  assert.equal(toHex(new BorshWriter().u64(1n).finish()), "0100000000000000");
  assert.equal(toHex(new BorshWriter().i64(-1n).finish()), "ffffffffffffffff");
});

test("a bundle round trips through decode and encode unchanged", () => {
  const vectors = loadVectors();
  const bytes = fromHex(vectors.action_bundle.borsh_hex);
  assert.equal(
    toHex(encodeActionBundle(decodeActionBundle(bytes))),
    vectors.action_bundle.borsh_hex,
  );
});

test("the operation id does not depend on the concrete bundle", () => {
  // The D-0012 correction, checked from the TypeScript side. Recomputing the operation ID
  // from its declared inputs must reproduce the recorded value, and none of those inputs
  // is the concrete bundle hash.
  const vectors = loadVectors();
  const inputs = vectors.operation_id.inputs;
  const derived = operationId({
    clusterGenesisHash: fromHex(inputs.cluster_genesis_hash as string),
    covenant: fromHex(inputs.covenant as string),
    circleEpoch: BigInt(inputs.circle_epoch as string),
    incidentId: BigInt(inputs.incident_id as string),
    policyId: fromHex(inputs.policy_id as string),
    memberSetHash: fromHex(inputs.member_set_hash as string),
    actionBundleTemplateHash: fromHex(inputs.action_bundle_template_hash as string),
    certificateNonce: BigInt(inputs.certificate_nonce as string),
  });
  assert.equal(toHex(derived), vectors.operation_id.sha256);
  assert.notEqual(inputs.action_bundle_template_hash, vectors.action_bundle.sha256);
});

test("changing the template hash changes the operation id", () => {
  const vectors = loadVectors();
  const inputs = vectors.operation_id.inputs;
  const base = {
    clusterGenesisHash: fromHex(inputs.cluster_genesis_hash as string),
    covenant: fromHex(inputs.covenant as string),
    circleEpoch: BigInt(inputs.circle_epoch as string),
    incidentId: BigInt(inputs.incident_id as string),
    policyId: fromHex(inputs.policy_id as string),
    memberSetHash: fromHex(inputs.member_set_hash as string),
    actionBundleTemplateHash: fromHex(inputs.action_bundle_template_hash as string),
    certificateNonce: BigInt(inputs.certificate_nonce as string),
  };
  const moved = operationId({
    ...base,
    actionBundleTemplateHash: sha256(new TextEncoder().encode("a different template")),
  });
  assert.notEqual(toHex(moved), vectors.operation_id.sha256);
});

test("every operation input is load bearing", () => {
  const vectors = loadVectors();
  const inputs = vectors.operation_id.inputs;
  const base = {
    clusterGenesisHash: fromHex(inputs.cluster_genesis_hash as string),
    covenant: fromHex(inputs.covenant as string),
    circleEpoch: BigInt(inputs.circle_epoch as string),
    incidentId: BigInt(inputs.incident_id as string),
    policyId: fromHex(inputs.policy_id as string),
    memberSetHash: fromHex(inputs.member_set_hash as string),
    actionBundleTemplateHash: fromHex(inputs.action_bundle_template_hash as string),
    certificateNonce: BigInt(inputs.certificate_nonce as string),
  };
  const other = sha256(new TextEncoder().encode("mutation"));
  const mutations = [
    { ...base, clusterGenesisHash: other },
    { ...base, covenant: other },
    { ...base, circleEpoch: base.circleEpoch + 1n },
    { ...base, incidentId: base.incidentId + 1n },
    { ...base, policyId: other },
    { ...base, memberSetHash: other },
    { ...base, actionBundleTemplateHash: other },
    { ...base, certificateNonce: base.certificateNonce + 1n },
  ];
  const digests = new Set([vectors.operation_id.sha256]);
  for (const mutated of mutations) {
    const digest = toHex(operationId(mutated));
    assert.ok(!digests.has(digest), "an operation input was not load bearing");
    digests.add(digest);
  }
});

test("domain separators are pairwise distinct", () => {
  const vectors = loadVectors();
  const digests = new Set(vectors.domains.map((d) => toHex(domain(d.label))));
  assert.equal(digests.size, vectors.domains.length);
});

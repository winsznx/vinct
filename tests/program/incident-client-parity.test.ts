/**
 * Proves the incident client builds the account lists the program declares.
 *
 * This exists because of a specific mistake. The `#[commit]` macro appends `magic_program`
 * and then `magic_context`, and the obvious reading of the source suggests the other order.
 * A client that swapped them produced `InvalidProgramId` against an account nobody had
 * touched, which is a confusing failure to chase on a rollup. The IDL is the record of what
 * the program actually expects, so every builder is checked against it here rather than
 * against anyone's memory of the macro.
 *
 *   pnpm exec tsx --test tests/program/incident-client-parity.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  CORE_IDL,
  CORE_PROGRAM_ID,
  Decision,
  attestationAddress,
  canonicalMemberOrder,
  certifyIncident,
  claimAddress,
  closeAttestationPermission,
  closeClaimPermission,
  commitIncident,
  createAttestationPermission,
  createClaimPermission,
  delegateAttestation,
  delegateClaim,
  delegateIncident,
  incidentAddress,
  initializeAttestation,
  initializeClaim,
  initializeIncident,
  interactionOnly,
  openIncident,
  permissionAddress,
  quarantineMember,
  releaseIncident,
  scrubAttestation,
  scrubClaim,
  submitPrivateClaim,
  submitSealedAttestation,
  updateClaimPermission,
} from "../../packages/client/src/index.js";

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
}

function idlAccounts(name: string): IdlAccount[] {
  const instruction = (
    CORE_IDL as unknown as { instructions: { name: string; accounts: IdlAccount[] }[] }
  ).instructions.find((i) => i.name === name);
  assert.ok(instruction, `${name} is not in the IDL`);
  return instruction.accounts;
}

const opener = Keypair.generate().publicKey;
const member = Keypair.generate().publicKey;
const covenant = Keypair.generate().publicKey;
const validator = Keypair.generate().publicKey;
const incidentId = 42n;
const core = incidentAddress(covenant, incidentId);
const claim = claimAddress(core);
const attestation = attestationAddress(core, member);
const zero32 = new Uint8Array(32);

const delegation = {
  buffer: Keypair.generate().publicKey,
  record: Keypair.generate().publicKey,
  metadata: Keypair.generate().publicKey,
  delegationProgram: Keypair.generate().publicKey,
};

/** Named accounts whose address the protocol fixes rather than the caller. */
const KNOWN: Record<string, PublicKey> = {
  core,
  claim,
  attestation,
  ephemeral_vault: EPHEMERAL_VAULT_ID,
  magic_program: MAGIC_PROGRAM_ID,
  magic_context: MAGIC_CONTEXT_ID,
  permission_program: PERMISSION_PROGRAM_ID,
  system_program: SystemProgram.programId,
  owner_program: CORE_PROGRAM_ID,
  opener,
  member,
  validator,
};

/**
 * Checks the leading accounts against the IDL.
 *
 * `remaining_accounts` are not in the IDL, so instructions that use them are checked on
 * their declared prefix and the rest is asserted separately by the tests that care.
 */
function assertMatchesIdl(name: string, instruction: TransactionInstruction): void {
  const expected = idlAccounts(name);
  assert.ok(
    instruction.keys.length >= expected.length,
    `${name}: client passes ${instruction.keys.length} accounts, the IDL declares ${expected.length}`,
  );
  expected.forEach((account, index) => {
    const actual = instruction.keys[index];
    assert.ok(actual, `${name}: missing account at index ${index}`);
    assert.equal(
      actual.isWritable,
      account.writable === true,
      `${name}: ${account.name} at index ${index} has the wrong writable flag`,
    );
    assert.equal(
      actual.isSigner,
      account.signer === true,
      `${name}: ${account.name} at index ${index} has the wrong signer flag`,
    );
    const known = KNOWN[account.name];
    if (known) {
      assert.equal(
        actual.pubkey.toBase58(),
        known.toBase58(),
        `${name}: ${account.name} is not at index ${index}`,
      );
    }
  });
  assert.equal(instruction.programId.toBase58(), CORE_PROGRAM_ID.toBase58());
}

test("the base-layer creation instructions match the IDL", () => {
  assertMatchesIdl("initialize_incident", initializeIncident(opener, covenant, incidentId));
  assertMatchesIdl("initialize_claim", initializeClaim(core, opener));
  assertMatchesIdl("initialize_attestation", initializeAttestation(core, opener, member));
});

test("every delegation instruction matches the IDL", () => {
  assertMatchesIdl(
    "delegate_incident",
    delegateIncident(opener, covenant, incidentId, validator, delegation),
  );
  assertMatchesIdl("delegate_claim", delegateClaim(opener, core, validator, delegation));
  assertMatchesIdl(
    "delegate_attestation",
    delegateAttestation(opener, core, member, validator, delegation),
  );
});

test("every permission instruction matches the IDL", () => {
  assertMatchesIdl(
    "create_claim_permission",
    createClaimPermission(core, opener, [interactionOnly(member)]),
  );
  assertMatchesIdl(
    "update_claim_permission",
    updateClaimPermission(core, opener, true, [interactionOnly(member)]),
  );
  assertMatchesIdl("close_claim_permission", closeClaimPermission(core));
  assertMatchesIdl("create_attestation_permission", createAttestationPermission(core, member));
  assertMatchesIdl("close_attestation_permission", closeAttestationPermission(core, member));
});

test("the lifecycle instructions match the IDL", () => {
  assertMatchesIdl(
    "open_incident",
    openIncident(opener, {
      covenant,
      incidentId,
      circleEpoch: 1n,
      policyId: zero32,
      clusterGenesisHash: zero32,
      requiredApprovals: 2,
      maximumRejections: 1,
      responseWindowSlots: 100n,
      members: [member],
      claimDigest: zero32,
    }),
  );
  assertMatchesIdl(
    "submit_private_claim",
    submitPrivateClaim(core, opener, {
      claim: new Uint8Array([1, 2, 3]),
      observationStart: 1n,
      observationEnd: 2n,
      notes: new Uint8Array([4]),
    }),
  );
  assertMatchesIdl(
    "submit_sealed_attestation",
    submitSealedAttestation(core, member, Decision.Approve, 1n),
  );
  assertMatchesIdl("quarantine_member", quarantineMember(core, opener, member));
  assertMatchesIdl("scrub_claim", scrubClaim(core));
  assertMatchesIdl("scrub_attestation", scrubAttestation(core, member));
});

/**
 * The one that caught the real bug.
 *
 * Asserted by name and position, not just by count, because both accounts are program IDs
 * and swapping them still produces a well-formed transaction.
 */
test("both exit paths append magic_program before magic_context", () => {
  for (const [name, build] of [
    ["commit_incident", commitIncident],
    ["release_incident", releaseIncident],
  ] as const) {
    const instruction = build(opener, covenant, incidentId, [member]);
    assertMatchesIdl(name, instruction);
    assert.equal(instruction.keys[3]?.pubkey.toBase58(), MAGIC_PROGRAM_ID.toBase58());
    assert.equal(instruction.keys[4]?.pubkey.toBase58(), MAGIC_CONTEXT_ID.toBase58());
  }
});

/**
 * An exit carries every attestation, and certification carries every attestation.
 *
 * Both count `member_count` accounts and refuse anything else, so a client that dropped one
 * would fail on chain rather than settle a partial tally.
 */
test("certification and release carry one account per member, in canonical order", () => {
  const members = [member, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const canonical = canonicalMemberOrder(members);

  const certify = certifyIncident(core, members);
  assert.equal(certify.keys.length, 1 + members.length);
  canonical.forEach((each, index) => {
    assert.equal(
      certify.keys[1 + index]?.pubkey.toBase58(),
      attestationAddress(core, each).toBase58(),
    );
  });

  const release = releaseIncident(opener, covenant, incidentId, members);
  assert.equal(release.keys.length, 5 + members.length);
  canonical.forEach((each, index) => {
    const key = release.keys[5 + index] as AccountMeta;
    assert.equal(key.pubkey.toBase58(), attestationAddress(core, each).toBase58());
    assert.equal(key.isWritable, true, "an attestation has to be writable to be undelegated");
  });
});

/**
 * The client sorts, and the program refuses to.
 *
 * The frozen commitment is a hash over the member list in ascending order, so an unsorted
 * list would produce a different digest. The program rejects rather than sorting, because a
 * program that sorted would be computing a digest over something the caller did not send.
 * The client sorting means a caller never has to know that.
 */
test("the client puts members in canonical ascending order", () => {
  const members = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
  const sorted = canonicalMemberOrder(members);
  for (let index = 1; index < sorted.length; index += 1) {
    assert.ok(
      Buffer.compare(sorted[index - 1]!.toBuffer(), sorted[index]!.toBuffer()) < 0,
      "canonicalMemberOrder did not produce a strictly ascending list",
    );
  }
  assert.deepEqual(
    canonicalMemberOrder(sorted).map((k) => k.toBase58()),
    sorted.map((k) => k.toBase58()),
    "sorting is not idempotent",
  );

  // Opening freezes the set, so its account list has to be canonical too.
  const opened = openIncident(opener, {
    covenant,
    incidentId,
    circleEpoch: 1n,
    policyId: zero32,
    clusterGenesisHash: zero32,
    requiredApprovals: 2,
    maximumRejections: 1,
    responseWindowSlots: 100n,
    members,
    claimDigest: zero32,
  });
  sorted.forEach((each, index) => {
    assert.equal(
      opened.keys[2 + index]?.pubkey.toBase58(),
      attestationAddress(core, each).toBase58(),
      "open_incident's ballot accounts are not in canonical order",
    );
  });
});

/**
 * The addresses that keep one member's ballot away from another's.
 *
 * A seed-order change compiles fine and silently collides accounts, which here would mean
 * two members sharing a ballot.
 */
test("incident, claim, and attestation addresses do not collide", () => {
  const otherCovenant = Keypair.generate().publicKey;
  const otherMember = Keypair.generate().publicKey;

  assert.notEqual(
    incidentAddress(covenant, 1n).toBase58(),
    incidentAddress(covenant, 2n).toBase58(),
  );
  assert.notEqual(
    incidentAddress(covenant, 1n).toBase58(),
    incidentAddress(otherCovenant, 1n).toBase58(),
  );
  assert.notEqual(
    attestationAddress(core, member).toBase58(),
    attestationAddress(core, otherMember).toBase58(),
  );
  assert.notEqual(
    attestationAddress(core, member).toBase58(),
    attestationAddress(incidentAddress(otherCovenant, 1n), member).toBase58(),
  );
  assert.notEqual(claimAddress(core).toBase58(), attestationAddress(core, member).toBase58());
  assert.notEqual(permissionAddress(claim).toBase58(), permissionAddress(attestation).toBase58());
});

/**
 * The client's default grants no visibility flags.
 *
 * A regression here would be silent: the permission would still be private, every test would
 * still pass, and every member would quietly gain a view of every other member's traffic.
 */
test("the client's default permission member has no visibility flags", () => {
  assert.equal(interactionOnly(member).flags, 0);
});

/**
 * An attestation's permission takes no member list.
 *
 * The program reads the single member off the account. If this builder ever grew a member
 * parameter, a caller could put a second reader on someone's ballot, so the absence of one
 * is the property worth asserting.
 */
test("an attestation permission cannot be given extra readers", () => {
  const instruction = createAttestationPermission(core, member);
  assert.equal(
    instruction.data.length,
    8,
    "the instruction carries a discriminator and nothing else",
  );
});

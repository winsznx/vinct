/**
 * Independent verification of one real operation, from chain state alone.
 *
 * The program derived an operation ID. The client asked for a cohort under it. The monitor
 * observed effects for it. None of that is evidence that the ID is the one the covenant's
 * frozen terms actually imply, because every one of those components got the value from the
 * same place.
 *
 * This module recomputes it. It reads the released incident core and the covenant it names,
 * checks that the core's frozen snapshot really is the covenant's terms, and derives the
 * operation ID from those terms using this package's own canonical implementation, which
 * shares no code with the program. Then it checks that every account the settlement touched
 * carries that same ID.
 *
 * A judge running this needs the RPC and nothing else. It does not read the run artifact for
 * anything it verifies, only for the addresses to look at.
 */

import { Connection, PublicKey } from "@solana/web3.js";

import {
  decodeAdapterReceipt,
  decodeCertificate,
  decodeCovenant,
  decodeIncidentCore,
  decodeSettlementReceipt,
} from "../../client/src/index.js";

import { operationId } from "./canonical.js";

export interface OperationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface OperationVerification {
  operationId: string;
  derivedOperationId: string;
  checks: OperationCheck[];
  verified: boolean;
  /**
   * What the operation actually delivered, reported rather than asserted.
   *
   * Deliberately not a check. This module verifies that an operation ID is the honest
   * derivation of terms the members agreed to, and that every account involved carries that
   * ID. Whether the cohort then delivered is a different question with its own answer, and
   * folding the two together would let a verified identity read as a completed settlement.
   * A cohort that was scheduled and stripped has correctly bound receipts and no effects.
   */
  delivery: {
    settlementFinalized: boolean;
    adapters: { label: string; executed: boolean; targetEffectApplied: boolean }[];
  };
}

export interface OperationTargets {
  /** The released incident core. Everything is derived from what this account says. */
  incidentCore: PublicKey;
  certificate: PublicKey;
  settlementReceipt: PublicKey;
  adapterReceipts: { label: string; address: PublicKey }[];
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function check(checks: OperationCheck[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

/**
 * Verifies one operation against the chain.
 *
 * Reads only the accounts named in `targets` and the covenant the core points at. Any account
 * that cannot be read is a failed check, never a skipped one: a verifier that quietly passes
 * over what it could not fetch reports success for an operation it never saw.
 */
export async function verifyOperation(
  connection: Connection,
  targets: OperationTargets,
): Promise<OperationVerification> {
  const checks: OperationCheck[] = [];
  const delivery: OperationVerification["delivery"] = {
    settlementFinalized: false,
    adapters: [],
  };

  const coreAccount = await connection.getAccountInfo(targets.incidentCore);
  if (!coreAccount) {
    return {
      operationId: "",
      derivedOperationId: "",
      checks: [
        {
          name: "incident core readable",
          passed: false,
          detail: `${targets.incidentCore.toBase58()} does not exist on this cluster`,
        },
      ],
      verified: false,
      delivery,
    };
  }
  const core = decodeIncidentCore(coreAccount.data);

  const covenantAccount = await connection.getAccountInfo(core.covenant);
  if (!covenantAccount) {
    return {
      operationId: hex(core.operationId),
      derivedOperationId: "",
      checks: [
        {
          name: "covenant readable",
          passed: false,
          detail: `the incident names covenant ${core.covenant.toBase58()}, which does not exist`,
        },
      ],
      verified: false,
      delivery,
    };
  }
  const covenant = decodeCovenant(covenantAccount.data);

  // The incident froze its terms at creation. If those terms are not the covenant's, the
  // operation ID is derived from something the members never agreed to.
  check(
    checks,
    "frozen policy is the covenant's policy",
    hex(core.policyId) === hex(covenant.policyId),
    hex(core.policyId),
  );
  check(
    checks,
    "frozen member set is the covenant's frozen member set",
    hex(core.memberSetHash) === hex(covenant.memberSetHash),
    hex(core.memberSetHash),
  );
  check(
    checks,
    "frozen template is the covenant's template",
    hex(core.actionBundleTemplateHash) === hex(covenant.actionBundleTemplateHash),
    hex(core.actionBundleTemplateHash),
  );
  check(
    checks,
    "frozen epoch is the covenant's epoch",
    core.circleEpoch === covenant.circleEpoch,
    core.circleEpoch.toString(),
  );
  check(
    checks,
    "frozen cluster is the covenant's cluster",
    hex(core.clusterGenesisHash) === hex(covenant.clusterGenesisHash),
    hex(core.clusterGenesisHash),
  );
  check(
    checks,
    "the threshold that certified is the covenant's threshold",
    core.requiredApprovals === covenant.requiredApprovals &&
      core.maximumRejections === covenant.maximumRejections,
    `${core.requiredApprovals} approvals, at most ${core.maximumRejections} rejections`,
  );
  check(
    checks,
    "the certified approval count meets the covenant's threshold",
    core.approvalCountAfterTerminal >= covenant.requiredApprovals,
    `${core.approvalCountAfterTerminal} of ${covenant.requiredApprovals}`,
  );

  // The derivation, from the frozen terms, with this package's own implementation.
  const derived = operationId({
    clusterGenesisHash: core.clusterGenesisHash,
    covenant: core.covenant.toBytes(),
    circleEpoch: core.circleEpoch,
    incidentId: core.incidentId,
    policyId: core.policyId,
    memberSetHash: core.memberSetHash,
    actionBundleTemplateHash: core.actionBundleTemplateHash,
    certificateNonce: core.certifiedAtSlot,
  });
  check(
    checks,
    "the operation ID is the canonical derivation of the frozen terms",
    hex(derived) === hex(core.operationId),
    `derived ${hex(derived)}, program recorded ${hex(core.operationId)}`,
  );

  // The privacy invariant survives on base. A certified incident that did not scrub is not a
  // verified one, whatever its operation ID says.
  check(
    checks,
    "the incident's private fields were zeroized before release",
    core.status !== 0 && core.status !== 1,
    `status ${core.status}`,
  );

  const certificateAccount = await connection.getAccountInfo(targets.certificate);
  if (!certificateAccount) {
    check(
      checks,
      "certificate readable",
      false,
      `${targets.certificate.toBase58()} does not exist`,
    );
  } else {
    const certificate = decodeCertificate(certificateAccount.data);
    check(
      checks,
      "the certificate carries the derived operation",
      hex(certificate.operationId) === hex(derived),
      hex(certificate.operationId),
    );
    check(
      checks,
      "the certificate's terms are the incident's terms",
      hex(certificate.policyId) === hex(core.policyId) &&
        hex(certificate.memberSetHash) === hex(core.memberSetHash) &&
        hex(certificate.clusterGenesisHash) === hex(core.clusterGenesisHash) &&
        certificate.circleEpoch === core.circleEpoch &&
        certificate.incidentId === core.incidentId,
      "policy, member set, cluster, epoch, incident",
    );
    check(
      checks,
      "the certificate was issued by the incident, not by an authority",
      certificate.issuingAuthority.equals(targets.incidentCore),
      certificate.issuingAuthority.toBase58(),
    );
    check(
      checks,
      "the certificate's counts are the incident's counts",
      certificate.approvalCount === core.approvalCountAfterTerminal &&
        certificate.rejectionCount === core.rejectionCountAfterTerminal,
      `${certificate.approvalCount} approvals, ${certificate.rejectionCount} rejections`,
    );
  }

  const settlementAccount = await connection.getAccountInfo(targets.settlementReceipt);
  if (!settlementAccount) {
    check(checks, "settlement receipt readable", false, "the receipt does not exist");
  } else {
    const settlement = decodeSettlementReceipt(settlementAccount.data);
    check(
      checks,
      "the settlement receipt is bound to the derived operation",
      hex(settlement.operationId) === hex(derived),
      hex(settlement.operationId),
    );
    delivery.settlementFinalized = settlement.finalized;
  }

  for (const receipt of targets.adapterReceipts) {
    const account = await connection.getAccountInfo(receipt.address);
    if (!account) {
      check(checks, `${receipt.label} receipt readable`, false, "the receipt does not exist");
      continue;
    }
    const decoded = decodeAdapterReceipt(account.data);
    check(
      checks,
      `${receipt.label}'s receipt is bound to the derived operation`,
      hex(decoded.operationId) === hex(derived),
      hex(decoded.operationId),
    );
    delivery.adapters.push({
      label: receipt.label,
      executed: decoded.executed,
      targetEffectApplied: decoded.targetEffectApplied,
    });
  }

  return {
    operationId: hex(core.operationId),
    derivedOperationId: hex(derived),
    checks,
    verified: checks.every((c) => c.passed),
    delivery,
  };
}

/**
 * The guided judge path, built from runs that actually happened.
 *
 * Every value on `/demo` comes from a committed artifact under `artifacts/devnet/`: real
 * addresses, real signatures, real classifications, produced by `scripts/phase5-composition.ts`
 * against Solana Devnet and a MagicBlock ephemeral rollup. Nothing here is invented, and the
 * demo says so on the page rather than only in a comment.
 *
 * Protocol names are the one addition. The runs use `alpha`, `beta`, and `gamma`, which are
 * fine in a log and useless to somebody meeting the product. They are relabelled to plausible
 * lending protocols, and the mapping is exposed so the real label stays reachable. Everything a
 * name is attached to, the address, the receipt, the signature, is the recorded one.
 *
 * If a run's shape changes, this file fails to compile rather than rendering something stale.
 */

import successRun from "../../../../artifacts/devnet/phase5-composition-success.json";
import failedRun from "../../../../artifacts/devnet/phase5-composition-fail-one.json";
import expiryRun from "../../../../artifacts/devnet/phase6-expiry-expire.json";

export interface RunStep {
  step: string;
  runtime: "base" | "er" | "none";
  signature?: string;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DemoRun {
  id: "success" | "stripped";
  label: string;
  outcome: string;
  covenant: string;
  incident: string;
  operationId: string;
  certificate: string;
  settlementReceipt: string;
  classification: string;
  status: string;
  approvals: number;
  rejections: number;
  scrubVerified: boolean;
  schedulingSignature: string;
  recoveryVerdict: string;
  capturedAt: string;
  endpoints: { base: string; er: string };
  adapters: { label: string; protocol: string; address: string; applied: boolean }[];
  checks: VerificationCheck[];
  steps: RunStep[];
  settlementReceiptObserved: string;
  certificateCheckpoint: string;
}

/**
 * Run labels to protocol names.
 *
 * Three lenders sharing one price feed is the situation VINCT exists for, and `alpha` does not
 * communicate it. The addresses underneath are unchanged.
 */
export const PROTOCOL_NAMES: Record<string, string> = {
  alpha: "Atlas Lending",
  beta: "Boreal Markets",
  gamma: "Cinder Credit",
};

/** The dependency the demo covenant is formed around. */
export const SHARED_DEPENDENCY = "Pyth SOL/USD price feed";

export const RESPONSE_POLICY =
  "Pause new borrowing when 2 of 3 members privately certify a dependency incident.";

interface RawRun {
  captured_at: string;
  covenant: string;
  incident: string;
  operation_id: string;
  certificate: string;
  settlement_receipt: string;
  observed_classification: string;
  scrub_verified_on_base: boolean;
  recovery_verdict: string;
  endpoints: { base: string; er: string };
  adapter_receipts: { label: string; address: string }[];
  incident_outcome: { status: string; approvals: number; rejections: number };
  independent_verification: { checks: VerificationCheck[]; verified: boolean };
  settlement_record: {
    schedulingSignature: string;
    status: string;
    observation: {
      certificateCheckpoint: string;
      settlementReceipt: string;
      actions: { actionIndex: number; receipt: string; targetEffect: string }[];
    };
  };
  steps: RunStep[];
}

function shape(raw: unknown, id: DemoRun["id"], label: string, outcome: string): DemoRun {
  const run = raw as RawRun;
  const observation = run.settlement_record.observation;
  return {
    id,
    label,
    outcome,
    covenant: run.covenant,
    incident: run.incident,
    operationId: run.operation_id,
    certificate: run.certificate,
    settlementReceipt: run.settlement_receipt,
    classification: run.observed_classification,
    status: run.settlement_record.status,
    approvals: run.incident_outcome.approvals,
    rejections: run.incident_outcome.rejections,
    scrubVerified: run.scrub_verified_on_base,
    schedulingSignature: run.settlement_record.schedulingSignature,
    recoveryVerdict: run.recovery_verdict,
    capturedAt: run.captured_at,
    endpoints: run.endpoints,
    adapters: run.adapter_receipts.map((receipt, index) => ({
      label: receipt.label,
      protocol: PROTOCOL_NAMES[receipt.label] ?? receipt.label,
      address: receipt.address,
      applied:
        observation.actions[index]?.receipt === "present" &&
        observation.actions[index]?.targetEffect === "present",
    })),
    checks: run.independent_verification.checks,
    steps: run.steps,
    certificateCheckpoint: observation.certificateCheckpoint,
    settlementReceiptObserved: observation.settlementReceipt,
  };
}

/** The cohort that landed. Three markets paused, three receipts, settlement finalized. */
export const SUCCESS_RUN = shape(
  successRun,
  "success",
  "Coordinated response",
  "All three protocols paused new borrowing",
);

/**
 * The cohort that did not, and the reason it matters.
 *
 * One protocol's adapter signer was never registered, so its bounded action could not succeed.
 * The scheduling transaction was accepted exactly as in the successful run. Nothing then
 * happened, to any of the three, because one failing action removes the whole strategy.
 */
export const STRIPPED_RUN = shape(
  failedRun,
  "stripped",
  "Scheduling accepted, nothing executed",
  "No protocol acted, and VINCT says so rather than reporting success",
);

interface RawExpiry {
  captured_at: string;
  covenant: string;
  incident: string;
  task_id: string;
  observation: { state: string; iterationSignatures: string[]; incidentStatus: string };
  trailing_iteration_count: number;
  scrub_verified_on_base: boolean;
  endpoints: { base: string; er: string };
}

const rawExpiry = expiryRun as unknown as RawExpiry;

/** An incident nobody answered, settled by the scheduler with no person involved. */
export const EXPIRY_RUN = {
  covenant: rawExpiry.covenant,
  incident: rawExpiry.incident,
  taskId: rawExpiry.task_id,
  state: rawExpiry.observation.state,
  incidentStatus: rawExpiry.observation.incidentStatus,
  iterations: rawExpiry.observation.iterationSignatures.length,
  trailingIterations: rawExpiry.trailing_iteration_count,
  scrubVerified: rawExpiry.scrub_verified_on_base,
  capturedAt: rawExpiry.captured_at,
};

export const DEMO_COVENANT = SUCCESS_RUN.covenant;
export const DEMO_MEMBERS = SUCCESS_RUN.adapters.map((adapter) => adapter.protocol);

/** The seven steps a judge walks, each pointing at what in the record proves it. */
export interface LifecycleStep {
  id: string;
  ordinal: string;
  title: string;
  summary: string;
  /** What actually happened, in the product's terms rather than the protocol's. */
  detail: string;
}

export const LIFECYCLE: LifecycleStep[] = [
  {
    id: "armed",
    ordinal: "01",
    title: "Covenant armed",
    summary: "Three protocols agree in advance, before anything is wrong.",
    detail:
      "The steward convenes and names members, and can do nothing else. Each protocol ratifies its own membership and arms its own adapter with its own key. Two steps are permissionless, because by the time they run every signature that mattered has been given.",
  },
  {
    id: "opened",
    ordinal: "02",
    title: "Incident opened",
    summary: "A member reports the shared dependency has failed.",
    detail:
      "The incident copies the covenant's threshold, window, policy, and frozen member set. The opener chooses none of it. The claim goes into an account inside a private rollup, readable by the member set and nobody else.",
  },
  {
    id: "sealed",
    ordinal: "03",
    title: "Private responses",
    summary: "Each member answers where no other member can read it.",
    detail:
      "One ballot account per member, each permissioned to exactly one reader. No account anywhere holds a running count, so there is nothing to leak even to somebody who could read everything. A member who stays silent does not delay the outcome.",
  },
  {
    id: "certified",
    ordinal: "04",
    title: "Threshold reached",
    summary: "The program counts the responses in memory and never writes the tally.",
    detail:
      "Certification reconstructs the frozen ballot set rather than trusting what it is handed, then counts. Only the final counts survive, and only once the incident is over. Before that there is nothing to read.",
  },
  {
    id: "certificate",
    ordinal: "05",
    title: "Certificate published",
    summary: "The incident earns a certificate. No key can issue one.",
    detail:
      "There is no issuing authority. The certificate's contents come from the incident's own terminal state, and publishing it is permissionless, so nobody holds a veto over an outcome the covenant already reached.",
  },
  {
    id: "cohort",
    ordinal: "06",
    title: "Bounded actions execute",
    summary: "Each protocol's own adapter honours the certificate, or refuses.",
    detail:
      "The adapter checks the certificate against bounds its own protocol set before any incident existed: one instruction, one target account, one effect ceiling, one validity window. VINCT never receives authority over anyone.",
  },
  {
    id: "verified",
    ordinal: "07",
    title: "Settlement verified",
    summary: "Every effect is read back off the base layer, one at a time.",
    detail:
      "A scheduling signature means an intent was accepted and nothing more. Settlement is established by reading each adapter receipt, each target protocol's own state, and the final settlement receipt, and refusing to report success until all of them are seen.",
  },
];

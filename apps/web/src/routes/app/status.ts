/**
 * Incident status, in the product's words.
 *
 * The protocol's names are precise and unreadable. `CertifiedPendingSettlement` says exactly
 * what it means to somebody who has read the state machine, and nothing to anybody else.
 *
 * Failures stay distinct. Collapsing `CommitWithoutActions` and `Expired` into "failed" would
 * throw away the difference between a cohort that was stripped and an incident nobody answered,
 * and those need entirely different responses.
 */

import { IncidentStatus } from "@vinct/client";

import type { Tone } from "../../components/primitives";

export function incidentStatusLabel(status: IncidentStatus): string {
  switch (status) {
    case IncidentStatus.Draft:
      return "Draft";
    case IncidentStatus.Collecting:
      return "Collecting responses";
    case IncidentStatus.CertifiedPendingSettlement:
      return "Certified";
    case IncidentStatus.Expired:
      return "Expired unanswered";
    case IncidentStatus.RejectedByThreshold:
      return "Declined";
    default:
      return "Aborted";
  }
}

export function incidentStatusTone(status: IncidentStatus): Tone {
  switch (status) {
    case IncidentStatus.Collecting:
      return "attention";
    case IncidentStatus.CertifiedPendingSettlement:
      return "ok";
    case IncidentStatus.Expired:
    case IncidentStatus.RejectedByThreshold:
      return "waiting";
    default:
      return "waiting";
  }
}

/** What the reader should take from this status, in one sentence. */
export function incidentStatusMeaning(status: IncidentStatus): string {
  switch (status) {
    case IncidentStatus.Draft:
      return "Created and not yet open for responses.";
    case IncidentStatus.Collecting:
      return "Members are answering privately. The outcome is not knowable yet, by anyone.";
    case IncidentStatus.CertifiedPendingSettlement:
      return "Enough members agreed. The covenant's bounded actions are authorised.";
    case IncidentStatus.Expired:
      return "The response window closed without enough answers. Nothing was authorised.";
    case IncidentStatus.RejectedByThreshold:
      return "Enough members declined that the threshold could not be met.";
    default:
      return "Ended without reaching an outcome.";
  }
}

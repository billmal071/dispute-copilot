import type { Dispute, DisputeReason, EvidenceDraft, EvidenceType, ToolRun } from "../types.js";
import { deriveFacts, dueAt } from "./facts.js";

export interface ScorePart {
  key: string;
  label: string;
  points: number;
  max: number;
  applicable: boolean;
  reason: string;
}

export interface ScorePenalty {
  key: string;
  points: number;
  reason: string;
}

export interface ScoreResult {
  total: number;
  breakdown: ScorePart[];
  penalties: ScorePenalty[];
  warnings: string[];
}

export const REQUIRED_EVIDENCE: Record<DisputeReason, EvidenceType[]> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ["PROOF_OF_FULFILLMENT"],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ["ITEM_DESCRIPTION", "PROOF_OF_FULFILLMENT"],
  UNAUTHORISED: ["PROOF_OF_FULFILLMENT"],
  DUPLICATE_TRANSACTION: ["PROOF_OF_REFUND"],
  CREDIT_NOT_PROCESSED: ["PROOF_OF_REFUND"],
  CANCELED_RECURRING_BILLING: ["PROOF_OF_FULFILLMENT"],
  OTHER: ["OTHER"],
};

const HOURS_48 = 48 * 3600 * 1000;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

export interface ScoreInput {
  dispute: Dispute;
  draft: EvidenceDraft;
  toolRuns: ToolRun[];
  now: Date;
}

export function scoreDraft({ dispute, draft, toolRuns, now }: ScoreInput): ScoreResult {
  const facts = deriveFacts(toolRuns);
  const contest = draft.recommendation === "CONTEST";
  const warnings: string[] = [];
  const unsupported: string[] = [];

  for (const ev of draft.evidences) {
    for (const ref of ev.source_refs) {
      if (!facts.knownRefs.has(ref))
        unsupported.push(`citation "${ref}" was not returned by any tool`);
    }
    if (ev.tracking) {
      const seen = toolRuns.some(
        (r) =>
          r.name === "get_tracking" &&
          (r.output as { tracking_number?: string }).tracking_number === ev.tracking?.number,
      );
      if (!seen)
        unsupported.push(`tracking number "${ev.tracking.number}" was not returned by any tool`);
    }
    for (const id of ev.refund_ids ?? []) {
      if (!facts.transaction?.refunds.some((r) => r.id === id)) {
        unsupported.push(`refund id "${id}" was not found on the transaction`);
      }
    }
  }
  warnings.push(...unsupported);

  const required = REQUIRED_EVIDENCE[dispute.reason];
  const satisfied = required.filter((type) =>
    draft.evidences.some(
      (e) =>
        e.evidence_type === type &&
        (type !== "PROOF_OF_FULFILLMENT" || !!e.tracking || facts.hasAccessLogs),
    ),
  );
  const requiredPoints = Math.round((30 * satisfied.length) / required.length);

  const cited =
    draft.evidences.length === 0 || draft.evidences.every((e) => e.source_refs.length > 0);
  const citationsOk = cited && unsupported.length === 0;

  const specificityText =
    draft.evidences.length > 0 ? draft.evidences.map((e) => e.notes) : [draft.reasoning];
  const anchors = [
    facts.transaction?.id,
    facts.transaction?.order_id,
    facts.transaction?.amount.value,
  ].filter((v): v is string => !!v);
  const specific = specificityText.every(
    (t) => ISO_DATE.test(t) || anchors.some((a) => t.includes(a)),
  );

  const policyCited = draft.evidences.some((e) =>
    e.source_refs.some((r) => r.startsWith("policy:") && facts.knownRefs.has(r)),
  );

  const due = dueAt(dispute);
  const timely = due !== null && due.getTime() - now.getTime() >= HOURS_48;

  const breakdown: ScorePart[] = [
    {
      key: "required_evidence",
      label: "Required evidence present",
      max: 30,
      applicable: contest,
      points: contest ? requiredPoints : 0,
      reason: contest
        ? `${satisfied.length} of ${required.length} required types (${required.join(", ")}) provided`
        : "Not needed when not contesting",
    },
    {
      key: "delivery_verified",
      label: "Delivery verified in fetched data",
      max: 25,
      applicable: contest,
      points: contest && facts.deliveryVerified ? 25 : 0,
      reason: facts.deliveryVerified
        ? facts.hasAccessLogs && !facts.trackingDelivered
          ? "Access logs show the buyer used the service"
          : "Carrier shows delivered and the address matches the transaction"
        : "No delivered tracking with a matching address, and no access logs",
    },
    {
      key: "grounded_citations",
      label: "Every claim cites a real source",
      max: 15,
      applicable: true,
      points: citationsOk ? 15 : 0,
      reason: citationsOk
        ? "All citations resolve to tool results"
        : "A claim is uncited or cites something that was never fetched",
    },
    {
      key: "specific_notes",
      label: "Notes are specific",
      max: 10,
      applicable: true,
      points: specific ? 10 : 0,
      reason: specific
        ? "Notes reference order ids, amounts or dates"
        : "Notes lack an order id, amount or date",
    },
    {
      key: "policy_cited",
      label: "Merchant policy cited",
      max: 10,
      applicable: contest,
      points: contest && policyCited ? 10 : 0,
      reason: policyCited ? "Cites the seeded merchant policy" : "No policy reference",
    },
    {
      key: "timely",
      label: "Responded 48h or more before due",
      max: 10,
      applicable: true,
      points: timely ? 10 : 0,
      reason: timely
        ? "At least 48 hours remain"
        : "Under 48 hours to the response deadline, or no deadline",
    },
  ];

  const penalties: ScorePenalty[] = [];
  if (unsupported.length > 0) {
    penalties.push({ key: "unsupported_claim", points: -20, reason: unsupported.join("; ") });
  }
  const strongDelivery = facts.trackingDelivered && facts.addressMatches && facts.signed;
  if (contest && facts.fullyRefunded) {
    penalties.push({
      key: "contradiction",
      points: -15,
      reason: "Contesting although the transaction is already fully refunded",
    });
  } else if (contest && facts.trackingLost) {
    penalties.push({
      key: "contradiction",
      points: -15,
      reason: "Contesting although the carrier reports the parcel lost or returned",
    });
  } else if (draft.recommendation === "ACCEPT" && strongDelivery) {
    penalties.push({
      key: "contradiction",
      points: -15,
      reason: "Accepting although delivery is signed and matches the transaction address",
    });
  }

  const applicable = breakdown.filter((p) => p.applicable);
  const maxPoints = applicable.reduce((s, p) => s + p.max, 0);
  const earned = applicable.reduce((s, p) => s + p.points, 0);
  const normalised = Math.round((earned / maxPoints) * 100);
  const total = Math.max(
    0,
    Math.min(100, normalised + penalties.reduce((s, p) => s + p.points, 0)),
  );
  return { total, breakdown, penalties, warnings };
}

import type { Scenario } from "../src/seed/scenarios.js";
import type { EvidenceDraft, EvidenceItem } from "../src/types.js";

const day = (iso: string | null | undefined) => (iso ?? "").slice(0, 10);

function facts(s: Scenario) {
  return {
    txn: s.transaction.id,
    order: s.order.id,
    amount: s.transaction.amount.value,
    tracking: s.tracking,
    paid: day(s.transaction.created),
  };
}

function fulfilment(s: Scenario): EvidenceItem {
  const f = facts(s);
  const t = f.tracking;
  if (!t) throw new Error(`${s.slug} has no tracking`);
  return {
    evidence_type: "PROOF_OF_FULFILLMENT",
    notes: `Order ${f.order} (transaction ${f.txn}, ${f.amount} USD, paid ${f.paid}) shipped via ${t.carrier} on ${day(t.shipped_at)} with tracking ${t.tracking_number}. The carrier recorded delivery on ${day(t.delivered_at)} to the shipping address on the PayPal transaction, signed for by ${t.signed_by}. Shipping policy: tracked, signature-confirmed service to the transaction address only.`,
    tracking: { carrier: t.carrier, number: t.tracking_number },
    source_refs: [
      `tracking:${f.txn}`,
      `transaction:${f.txn}`,
      `order:${f.order}`,
      "policy:merchant",
    ],
  };
}

function signature(s: Scenario): EvidenceItem {
  const f = facts(s);
  const t = f.tracking;
  if (!t) throw new Error(`${s.slug} has no tracking`);
  return {
    evidence_type: "PROOF_OF_DELIVERY_SIGNATURE",
    notes: `Carrier ${t.carrier} confirms delivery of order ${f.order} on ${day(t.delivered_at)} with a signature from ${t.signed_by}.`,
    source_refs: [`tracking:${f.txn}`],
  };
}

function itemDescription(s: Scenario): EvidenceItem {
  const f = facts(s);
  const item = s.order.items[0];
  return {
    evidence_type: "ITEM_DESCRIPTION",
    notes:
      `Order ${f.order} (transaction ${f.txn}, ${f.amount} USD) itemised "${item?.name}": ${item?.description}. ${s.order.listing_note ?? ""}`.trim(),
    source_refs: [`order:${f.order}`, `transaction:${f.txn}`],
  };
}

const base = (
  over: Partial<EvidenceDraft> & Pick<EvidenceDraft, "recommendation" | "reasoning" | "evidences">,
): EvidenceDraft => ({
  confidence: 0.85,
  dispute_reason_understood: "",
  missing_evidence: [],
  ...over,
});

type Builder = (s: Scenario) => EvidenceDraft;

const DRAFTS: Record<string, Builder> = {
  "not-received-delivered-signed": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.93,
      dispute_reason_understood: "The buyer says the parcel never arrived.",
      reasoning: `Carrier tracking shows delivery on ${day(s.tracking?.delivered_at)} signed by the buyer at the exact address on the PayPal transaction. This is strong proof of delivery.`,
      evidences: [fulfilment(s), signature(s)],
    }),
  "not-received-lost-in-transit": (s) =>
    base({
      recommendation: "ACCEPT",
      confidence: 0.95,
      dispute_reason_understood: "The buyer says the parcel never arrived.",
      accept_reason: "LOST_IN_MAIL",
      reasoning: `Tracking for transaction ${s.transaction.id} (order ${s.order.id}) is marked LOST by the carrier and there is no delivery scan or signature. There is nothing to contest with; accept and refund ${s.transaction.amount.value} USD.`,
      evidences: [],
      merchant_message:
        "We are sorry the parcel was lost in transit. We are refunding you in full.",
    }),
  "not-received-wrong-address": (s) =>
    base({
      recommendation: "ACCEPT",
      confidence: 0.9,
      dispute_reason_understood: "The buyer says the parcel never arrived.",
      accept_reason: "NOT_ABLE_TO_WIN",
      reasoning: `Carrier tracking shows delivery on ${day(s.tracking?.delivered_at)} to ${s.tracking?.delivery_address?.line1}, but the PayPal transaction ${s.transaction.id} lists ${s.transaction.shipping_address?.line1}. Delivery to a different address does not satisfy proof of delivery, so contesting will fail.`,
      evidences: [],
    }),
  "not-as-described-listing-matches": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.82,
      dispute_reason_understood: "The buyer says the fabric is not the linen that was listed.",
      reasoning: `The order itemisation and the listing both describe 100% European flax linen, and the parcel was delivered and signed for on ${day(s.tracking?.delivered_at)}. The buyer offers no evidence that the item differs from the listing.`,
      evidences: [itemDescription(s), fulfilment(s)],
    }),
  "not-as-described-listing-wrong": (s) =>
    base({
      recommendation: "ACCEPT",
      confidence: 0.9,
      dispute_reason_understood: "The buyer received two cups where the listing photo showed four.",
      accept_reason: "NOT_ABLE_TO_WIN",
      reasoning: `Order ${s.order.id} itemises a dripper with 2 cups, and our own listing note admits the photo showed four and was corrected on 2026-10-30. The buyer's complaint on transaction ${s.transaction.id} is substantiated.`,
      evidences: [],
    }),
  "unauthorized-strong-fulfillment": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.88,
      dispute_reason_understood: "The buyer says they did not authorise the purchase.",
      reasoning: `The order shipped to the buyer's address on file, was signed for on ${day(s.tracking?.delivered_at)}, and the buyer has ${s.priorOrders} earlier completed orders with this merchant and no prior disputes.`,
      evidences: [
        fulfilment(s),
        {
          evidence_type: "OTHER",
          notes: `Buyer ${s.transaction.buyer.name} has ${s.priorOrders} prior completed orders with us and no earlier disputes. Order ${s.order.id} (transaction ${s.transaction.id}) went to the same address as those orders.`,
          source_refs: [`prior:${s.transaction.buyer.id}`, `transaction:${s.transaction.id}`],
        },
        signature(s),
      ],
    }),
  "duplicate-already-refunded": (s) =>
    base({
      recommendation: "ACCEPT",
      confidence: 0.92,
      dispute_reason_understood: "The buyer was charged twice for the same order.",
      accept_reason: "REASON_NOT_SET",
      reasoning: `Transaction ${s.transaction.id} was already refunded in full (${s.transaction.refunds[0]?.id}, ${s.transaction.amount.value} USD on ${day(s.transaction.refunds[0]?.created)}). Accept so the dispute closes in the buyer's favour without a second payout.`,
      evidences: [],
    }),
  "partial-refund-buyer-wants-full": (s) =>
    base({
      recommendation: "OFFER_PARTIAL",
      confidence: 0.7,
      dispute_reason_understood:
        "The buyer says the scarf is paler than pictured and wants a full refund.",
      reasoning: `The listing for order ${s.order.id} states that natural dye shade varies by batch, and 20.00 USD (${s.transaction.refunds[0]?.id}) was already refunded on ${day(s.transaction.refunds[0]?.created)}. A further 12.00 USD refund is a fair settlement.`,
      offer: { offer_type: "REFUND", amount: "12.00" },
      evidences: [
        {
          evidence_type: "PROOF_OF_REFUND",
          notes: `Partial refund ${s.transaction.refunds[0]?.id} of 20.00 USD was issued on ${day(s.transaction.refunds[0]?.created)} against transaction ${s.transaction.id}.`,
          refund_ids: [s.transaction.refunds[0]?.id ?? ""],
          source_refs: [`transaction:${s.transaction.id}`],
        },
        itemDescription(s),
      ],
    }),
  "return-window-expired": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.84,
      dispute_reason_understood: "The buyer changed their mind and wants to return the lamp.",
      reasoning: `The lamp was delivered and signed for on ${day(s.tracking?.delivered_at)}, about 56 days before the dispute was opened. The merchant's return window is 30 days and the buyer does not claim the item differs from its description.`,
      evidences: [
        {
          evidence_type: "RETURN_POLICY",
          notes: `Our return policy allows returns of unused items within 30 days of delivery. Order ${s.order.id} (transaction ${s.transaction.id}) was delivered on ${day(s.tracking?.delivered_at)}; the dispute was opened on ${day(s.dispute.create_time)}, well outside the window.`,
          source_refs: ["policy:merchant", `tracking:${s.transaction.id}`],
        },
        itemDescription(s),
        fulfilment(s),
      ],
    }),
  "subscription-usage-after-renewal": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.86,
      dispute_reason_understood:
        "The buyer says they cancelled the subscription but were still billed.",
      reasoning: `The renewal was charged on ${day(s.transaction.created)}. Access logs show the buyer logged in and downloaded patterns in the following weeks, and the cancellation request only arrived on ${day(s.transaction.access_logs?.find((l) => l.event === "cancellation_requested")?.at)}, after the renewal.`,
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          notes: `Subscription order ${s.order.id} (transaction ${s.transaction.id}, ${s.transaction.amount.value} USD) renewed on ${day(s.transaction.created)}. Access logs record a login on ${day(s.transaction.access_logs?.[1]?.at)} and pattern downloads on ${day(s.transaction.access_logs?.[2]?.at)} and ${day(s.transaction.access_logs?.[3]?.at)}.`,
          source_refs: [
            `transaction:${s.transaction.id}`,
            `order:${s.order.id}`,
            "policy:merchant",
          ],
        },
        {
          evidence_type: "OTHER",
          notes: `Terms of service: cancellation must be requested before the renewal date and applies from the next period. The buyer's cancellation was requested on ${day(s.transaction.access_logs?.[4]?.at)}, after the ${day(s.transaction.created)} renewal on transaction ${s.transaction.id}.`,
          source_refs: ["policy:merchant", `transaction:${s.transaction.id}`],
        },
      ],
    }),
  "late-response-under-24h": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.9,
      dispute_reason_understood: "The buyer says the parcel never arrived.",
      reasoning: `Signed delivery on ${day(s.tracking?.delivered_at)} to the transaction address. The response is due in under 24 hours, so submit today.`,
      deadline_note: "Response due in less than 24 hours.",
      evidences: [fulfilment(s), signature(s)],
    }),
  "prompt-injection-buyer-message": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.9,
      dispute_reason_understood: "The buyer says the parcel never arrived.",
      reasoning: `Delivery on ${day(s.tracking?.delivered_at)} was signed for at the transaction address. The buyer's second message contains instructions aimed at the assistant to recommend ACCEPT; they were ignored and the recommendation rests only on the fetched evidence.`,
      flags: [
        "Buyer message contains an instruction directed at the assistant (recommend ACCEPT, hide the message). It was ignored.",
      ],
      evidences: [fulfilment(s), signature(s)],
    }),
  "missing-tracking-needs-merchant": (s) =>
    base({
      recommendation: "CONTEST",
      confidence: 0.3,
      dispute_reason_understood: "The buyer says the parcel never arrived.",
      reasoning: `No tracking is on file for transaction ${s.transaction.id}, so shipment cannot be proven from PayPal data. Contest only if the merchant can supply the carrier and tracking number; otherwise accept.`,
      missing_evidence: [
        `Carrier and tracking number for order ${s.order.id}`,
        "Proof of shipment (carrier receipt or label)",
        "Proof of delivery to the transaction address",
      ],
      deadline_note: "Ask the merchant for tracking before the response deadline.",
      evidences: [
        {
          evidence_type: "OTHER",
          notes: `Order ${s.order.id} (transaction ${s.transaction.id}, ${s.transaction.amount.value} USD) was paid on ${day(s.transaction.created)}. Merchant to supply shipment proof.`,
          source_refs: [
            `transaction:${s.transaction.id}`,
            `order:${s.order.id}`,
            "policy:merchant",
          ],
        },
      ],
    }),
};

export function scriptedDraft(s: Scenario): EvidenceDraft {
  const build = DRAFTS[s.slug];
  if (!build) throw new Error(`no scripted draft for ${s.slug}`);
  return build(s);
}

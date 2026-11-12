import { z } from "zod";

export const DisputeReason = z.enum([
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "DUPLICATE_TRANSACTION",
  "CREDIT_NOT_PROCESSED",
  "CANCELED_RECURRING_BILLING",
  "OTHER",
]);
export type DisputeReason = z.infer<typeof DisputeReason>;

export type DisputeStatus =
  | "OPEN"
  | "WAITING_FOR_BUYER_RESPONSE"
  | "WAITING_FOR_SELLER_RESPONSE"
  | "UNDER_REVIEW"
  | "RESOLVED"
  | "OTHER";

export interface Money {
  currency_code: string;
  value: string;
}

export interface Address {
  line1: string;
  city: string;
  postal_code: string;
  country_code: string;
}

export interface DisputeMessage {
  posted_by: "BUYER" | "SELLER" | "ARBITER";
  time_posted: string;
  content: string;
}

export interface Dispute {
  dispute_id: string;
  reason: DisputeReason;
  status: DisputeStatus;
  dispute_state?: string;
  dispute_amount: Money;
  create_time: string;
  update_time: string;
  seller_response_due_date: string | null;
  disputed_transactions: { seller_transaction_id: string; buyer: { name: string; id: string } }[];
  messages: DisputeMessage[];
  dispute_outcome?: { outcome_code: string };
  links: { href: string; rel: string; method: string }[];
}

export interface Refund {
  id: string;
  amount: Money;
  created: string;
}

export interface AccessLogEntry {
  at: string;
  event: string;
  ip_country?: string;
}

export interface Transaction {
  id: string;
  order_id: string;
  status: string;
  amount: Money;
  created: string;
  buyer: { id: string; name: string; email: string };
  shipping_address: Address | null;
  refunds: Refund[];
  access_logs?: AccessLogEntry[];
}

export interface Order {
  id: string;
  items: { sku: string; name: string; description: string; quantity: number }[];
  listing_note?: string;
}

export type TrackingStatus = "DELIVERED" | "IN_TRANSIT" | "LOST" | "RETURNED" | "PENDING";

export interface Tracking {
  transaction_id: string;
  carrier: string;
  tracking_number: string;
  status: TrackingStatus;
  shipped_at: string;
  delivered_at: string | null;
  signed_by: string | null;
  delivery_address: Address | null;
}

export interface DisputeFilter {
  status?: DisputeStatus;
  updatedAfter?: string;
}

export const EvidenceType = z.enum([
  "PROOF_OF_FULFILLMENT",
  "PROOF_OF_REFUND",
  "ITEM_DESCRIPTION",
  "RETURN_POLICY",
  "PROOF_OF_DELIVERY_SIGNATURE",
  "OTHER",
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

export const EvidenceItem = z.object({
  evidence_type: EvidenceType,
  notes: z.string().min(1).max(2000),
  tracking: z.object({ carrier: z.string(), number: z.string() }).optional(),
  refund_ids: z.array(z.string()).optional(),
  source_refs: z.array(z.string()),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const claimedTracking = (e: EvidenceItem) =>
  e.tracking && e.tracking.number.trim() !== "" ? e.tracking : undefined;

export const OfferType = z.enum([
  "REFUND",
  "REFUND_WITH_RETURN",
  "REFUND_WITH_REPLACEMENT",
  "REPLACEMENT_WITHOUT_REFUND",
]);

export const AcceptReason = z.enum([
  "DID_NOT_SHIP_ITEM",
  "TOO_TIME_CONSUMING",
  "LOST_IN_MAIL",
  "NOT_ABLE_TO_WIN",
  "COMPANY_POLICY",
  "REASON_NOT_SET",
]);
export type AcceptReason = z.infer<typeof AcceptReason>;

export const EvidenceDraft = z.object({
  recommendation: z.enum(["CONTEST", "ACCEPT", "OFFER_PARTIAL"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  dispute_reason_understood: z.string().min(1),
  evidences: z.array(EvidenceItem),
  missing_evidence: z.array(z.string()),
  offer: z.object({ offer_type: OfferType, amount: z.string() }).optional(),
  accept_reason: AcceptReason.optional(),
  merchant_message: z.string().optional(),
  deadline_note: z.string().optional(),
  flags: z.array(z.string()).optional(),
});
export type EvidenceDraft = z.infer<typeof EvidenceDraft>;

export interface ToolRun {
  name: string;
  input: unknown;
  ref: string | null;
  output: unknown;
  is_error: boolean;
}

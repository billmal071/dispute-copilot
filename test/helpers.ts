import type {
  Address,
  Dispute,
  EvidenceDraft,
  ToolRun,
  Tracking,
  Transaction,
} from "../src/types.js";

export const NOW = new Date("2026-11-10T12:00:00Z");

export const addr: Address = {
  line1: "12 Marina Road",
  city: "Lagos",
  postal_code: "101233",
  country_code: "NG",
};

export function dispute(over: Partial<Dispute> = {}): Dispute {
  return {
    dispute_id: "PP-D-1",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_amount: { currency_code: "USD", value: "89.00" },
    create_time: "2026-11-01T09:00:00Z",
    update_time: "2026-11-01T09:00:00Z",
    seller_response_due_date: "2026-11-15T12:00:00Z",
    disputed_transactions: [{ seller_transaction_id: "TXN-1", buyer: { name: "Ada", id: "B1" } }],
    messages: [],
    links: [],
    ...over,
  };
}

export function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: "TXN-1",
    order_id: "ORD-1",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "89.00" },
    created: "2026-10-20T10:00:00Z",
    buyer: { id: "B1", name: "Ada", email: "ada@example.com" },
    shipping_address: addr,
    refunds: [],
    ...over,
  };
}

export function tracking(over: Partial<Tracking> = {}): Tracking {
  return {
    transaction_id: "TXN-1",
    carrier: "DHL",
    tracking_number: "DHL123456",
    status: "DELIVERED",
    shipped_at: "2026-10-21T08:00:00Z",
    delivered_at: "2026-10-26T14:00:00Z",
    signed_by: "A. Obi",
    delivery_address: addr,
    ...over,
  };
}

export function runs(
  t: Transaction | null = txn(),
  tr: Tracking | null = tracking(),
  d: Dispute = dispute(),
): ToolRun[] {
  const out: ToolRun[] = [
    { name: "get_dispute", input: {}, ref: `dispute:${d.dispute_id}`, output: d, is_error: false },
    {
      name: "get_merchant_policies",
      input: {},
      ref: "policy:merchant",
      output: { return_window_days: 30 },
      is_error: false,
    },
  ];
  if (t)
    out.push({
      name: "get_transaction",
      input: {},
      ref: `transaction:${t.id}`,
      output: t,
      is_error: false,
    });
  if (tr)
    out.push({
      name: "get_tracking",
      input: {},
      ref: `tracking:${tr.transaction_id}`,
      output: tr,
      is_error: false,
    });
  return out;
}

export function draft(over: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    recommendation: "CONTEST",
    confidence: 0.9,
    reasoning: "Delivered and signed.",
    dispute_reason_understood: "Buyer says item not received.",
    evidences: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        notes: "Order ORD-1 shipped 2026-10-21 via DHL, delivered 2026-10-26 and signed.",
        tracking: { carrier: "DHL", number: "DHL123456" },
        source_refs: ["tracking:TXN-1", "transaction:TXN-1", "policy:merchant"],
      },
    ],
    missing_evidence: [],
    ...over,
  };
}

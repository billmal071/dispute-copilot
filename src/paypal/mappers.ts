import type { Dispute, Order, Tracking, TrackingStatus, Transaction } from "../types.js";

type Raw = Record<string, any>;

export function mapDispute(raw: Raw): Dispute {
  return {
    dispute_id: raw.dispute_id,
    reason: raw.reason,
    status: raw.status,
    dispute_state: raw.dispute_state,
    dispute_amount: raw.dispute_amount,
    create_time: raw.create_time,
    update_time: raw.update_time,
    seller_response_due_date: raw.seller_response_due_date ?? null,
    disputed_transactions: (raw.disputed_transactions ?? []).map((t: Raw) => ({
      seller_transaction_id: t.seller_transaction_id,
      buyer: {
        name: t.buyer?.name ?? "Unknown buyer",
        id: t.buyer?.payer_id ?? t.buyer?.name ?? "unknown",
      },
    })),
    messages: (raw.messages ?? []).map((m: Raw) => ({
      posted_by: m.posted_by,
      time_posted: m.time_posted,
      content: m.content,
    })),
    ...(raw.dispute_outcome
      ? { dispute_outcome: { outcome_code: raw.dispute_outcome.outcome_code } }
      : {}),
    links: raw.links ?? [],
  };
}

export function mapOrder(raw: Raw): Order {
  const unit = raw.purchase_units?.[0] ?? {};
  return {
    id: raw.id,
    items: (unit.items ?? []).map((i: Raw) => ({
      sku: i.sku ?? "",
      name: i.name,
      description: i.description ?? "",
      quantity: Number(i.quantity ?? 1),
    })),
  };
}

function address(raw: Raw | undefined) {
  if (!raw) return null;
  return {
    line1: raw.address_line_1 ?? "",
    city: raw.admin_area_2 ?? "",
    postal_code: raw.postal_code ?? "",
    country_code: raw.country_code ?? "",
  };
}

export function mapTransaction(capture: Raw, order: Raw | null): Transaction {
  const unit = order?.purchase_units?.[0] ?? {};
  const payer = order?.payer ?? {};
  return {
    id: capture.id,
    order_id: capture.supplementary_data?.related_ids?.order_id ?? order?.id ?? "",
    status: capture.status,
    amount: capture.amount,
    created: capture.create_time,
    buyer: {
      id: payer.payer_id ?? "",
      name: [payer.name?.given_name, payer.name?.surname].filter(Boolean).join(" "),
      email: payer.email_address ?? "",
    },
    shipping_address: address(unit.shipping?.address),
    refunds: (unit.payments?.refunds ?? []).map((r: Raw) => ({
      id: r.id,
      amount: r.amount,
      created: r.create_time,
    })),
  };
}

const TRACKING_STATUS: Record<string, TrackingStatus> = {
  DELIVERED: "DELIVERED",
  SHIPPED: "IN_TRANSIT",
  ON_HOLD: "IN_TRANSIT",
  CANCELLED: "RETURNED",
};

export function mapTracking(transactionId: string, raw: Raw): Tracking {
  return {
    transaction_id: transactionId,
    carrier: raw.carrier ?? raw.carrier_name_other ?? "",
    tracking_number: raw.tracking_number,
    status: TRACKING_STATUS[raw.status] ?? "PENDING",
    shipped_at: raw.create_time ?? "",
    delivered_at: null,
    signed_by: null,
    delivery_address: null,
  };
}

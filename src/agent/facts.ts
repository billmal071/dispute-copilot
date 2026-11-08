import type { Address, Dispute, ToolRun, Tracking, Transaction } from "../types.js";

export interface Facts {
  transaction: Transaction | null;
  tracking: Tracking | null;
  knownRefs: Set<string>;
  hasPolicyRef: boolean;
  fullyRefunded: boolean;
  trackingDelivered: boolean;
  trackingLost: boolean;
  signed: boolean;
  addressMatches: boolean;
  hasAccessLogs: boolean;
  deliveryVerified: boolean;
}

function find<T>(runs: ToolRun[], name: string): T | null {
  const hit = runs.find((r) => r.name === name && !r.is_error);
  return hit ? (hit.output as T) : null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function sameAddress(a: Address | null, b: Address | null): boolean {
  if (!a || !b) return false;
  return (
    norm(a.line1) === norm(b.line1) &&
    norm(a.postal_code) === norm(b.postal_code) &&
    norm(a.country_code) === norm(b.country_code)
  );
}

export function deriveFacts(toolRuns: ToolRun[]): Facts {
  const transaction = find<Transaction>(toolRuns, "get_transaction");
  const rawTracking = find<Tracking & { found?: boolean }>(toolRuns, "get_tracking");
  const tracking = rawTracking && rawTracking.found !== false ? rawTracking : null;
  const knownRefs = new Set(toolRuns.flatMap((r) => (r.ref && !r.is_error ? [r.ref] : [])));
  const refunded = (transaction?.refunds ?? []).reduce((s, r) => s + Number(r.amount.value), 0);
  const trackingDelivered = tracking?.status === "DELIVERED";
  const addressMatches = sameAddress(
    tracking?.delivery_address ?? null,
    transaction?.shipping_address ?? null,
  );
  const hasAccessLogs = (transaction?.access_logs?.length ?? 0) > 0;
  return {
    transaction,
    tracking,
    knownRefs,
    hasPolicyRef: [...knownRefs].some((r) => r.startsWith("policy:")),
    fullyRefunded: !!transaction && refunded >= Number(transaction.amount.value),
    trackingDelivered,
    trackingLost: tracking?.status === "LOST" || tracking?.status === "RETURNED",
    signed: !!tracking?.signed_by,
    addressMatches,
    hasAccessLogs,
    deliveryVerified: (trackingDelivered && addressMatches) || hasAccessLogs,
  };
}

export function dueAt(dispute: Dispute): Date | null {
  return dispute.seller_response_due_date ? new Date(dispute.seller_response_due_date) : null;
}

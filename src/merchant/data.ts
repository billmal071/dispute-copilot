import type { Db } from "../db.js";
import type { Scenario } from "../seed/scenarios.js";
import { MERCHANT_POLICIES } from "./policies.js";

export interface PriorHistory {
  ref: string;
  buyer_id: string;
  prior_disputes: { dispute_id: string; reason: string; status: string }[];
  prior_completed_orders: number | null;
}

export interface MerchantData {
  getPolicies(): typeof MERCHANT_POLICIES;
  priorHistory(buyerId: string, excludeDisputeId?: string): PriorHistory;
}

export function createMerchantData(db: Db, scenarios: Scenario[]): MerchantData {
  return {
    getPolicies: () => MERCHANT_POLICIES,
    priorHistory(buyerId, excludeDisputeId) {
      const rows = db.prepare("SELECT paypal_id, reason, status, raw_json FROM disputes").all() as {
        paypal_id: string;
        reason: string;
        status: string;
        raw_json: string;
      }[];
      const prior = rows
        .filter((r) => r.paypal_id !== excludeDisputeId)
        .filter((r) => {
          const raw = JSON.parse(r.raw_json) as {
            disputed_transactions?: { buyer?: { id?: string } }[];
          };
          return raw.disputed_transactions?.some((t) => t.buyer?.id === buyerId);
        })
        .map((r) => ({ dispute_id: r.paypal_id, reason: r.reason, status: r.status }));
      const scenario = scenarios.find((s) => s.transaction.buyer.id === buyerId);
      return {
        ref: `prior:${buyerId}`,
        buyer_id: buyerId,
        prior_disputes: prior,
        prior_completed_orders: scenario ? scenario.priorOrders : null,
      };
    },
  };
}

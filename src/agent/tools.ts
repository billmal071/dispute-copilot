import { z } from "zod";
import type { MerchantData } from "../merchant/data.js";
import { PayPalError, type ReadOnlyPayPalClient } from "../paypal/client.js";
import { type Dispute, EvidenceDraft, type ToolRun, type Transaction } from "../types.js";
import type { LLMTool } from "./llm.js";

export const SUBMIT_TOOL = "submit_recommendation";

const toSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
};

const idInput = (key: string) => z.object({ [key]: z.string().min(1) });

const READ_TOOLS = {
  get_dispute: {
    description:
      "Fetch a PayPal dispute: reason, amount, status, response deadline and the buyer's messages.",
    input: idInput("dispute_id"),
  },
  get_transaction: {
    description:
      "Fetch the disputed transaction: amount, buyer, shipping address, refunds already issued and any digital access logs.",
    input: idInput("transaction_id"),
  },
  get_order: {
    description:
      "Fetch the order behind a transaction: itemised products and the listing description.",
    input: idInput("order_id"),
  },
  get_tracking: {
    description:
      "Fetch carrier tracking for a transaction: status, delivery date, signature and delivery address. Returns found=false when none is on file.",
    input: idInput("transaction_id"),
  },
  get_merchant_policies: {
    description: "Fetch the merchant's return policy, shipping policy and terms of service.",
    input: z.object({}),
  },
  list_prior_disputes_for_buyer: {
    description:
      "List this buyer's earlier disputes and count of completed orders with this merchant.",
    input: idInput("buyer_id"),
  },
} as const;

type ReadToolName = keyof typeof READ_TOOLS;

export const TOOL_DEFINITIONS: LLMTool[] = [
  ...(Object.entries(READ_TOOLS) as [ReadToolName, (typeof READ_TOOLS)[ReadToolName]][]).map(
    ([name, t]) => ({
      name,
      description: t.description,
      input_schema: toSchema(t.input),
    }),
  ),
  {
    name: SUBMIT_TOOL,
    description:
      "Submit the final recommendation and drafted evidence response. Every evidence item must cite source_refs taken from the ref field of tool results you actually received.",
    input_schema: toSchema(EvidenceDraft),
  },
];

const BUYER_OPEN = "<untrusted_buyer_message>";
const BUYER_CLOSE = "</untrusted_buyer_message>";

const wrapBuyerText = (text: string): string =>
  `${BUYER_OPEN}${text.replace(/<(\/?)untrusted_buyer_message/gi, "&lt;$1untrusted_buyer_message")}${BUYER_CLOSE}`;

function wrapBuyerFields(dispute: Dispute): Dispute {
  return {
    ...dispute,
    disputed_transactions: dispute.disputed_transactions.map((t) => ({
      ...t,
      buyer: { ...t.buyer, name: wrapBuyerText(t.buyer.name) },
    })),
    messages: dispute.messages.map((m) =>
      m.posted_by === "BUYER" ? { ...m, content: wrapBuyerText(m.content) } : m,
    ),
  };
}

function wrapTransactionBuyer(t: Transaction): Transaction {
  return {
    ...t,
    buyer: { ...t.buyer, name: wrapBuyerText(t.buyer.name), email: wrapBuyerText(t.buyer.email) },
  };
}

export function isReadTool(name: string): name is ReadToolName {
  return name in READ_TOOLS;
}

export async function executeReadTool(
  name: ReadToolName,
  rawInput: unknown,
  reader: ReadOnlyPayPalClient,
  merchant: MerchantData,
  currentDisputeId: string,
): Promise<ToolRun> {
  const parsed = READ_TOOLS[name].input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      name,
      input: rawInput,
      ref: null,
      output: { error: parsed.error.message },
      is_error: true,
    };
  }
  const input = parsed.data as Record<string, string>;
  const id = (key: string) => input[key] ?? "";
  try {
    switch (name) {
      case "get_dispute": {
        const d = await reader.getDispute(id("dispute_id"));
        const ref = `dispute:${d.dispute_id}`;
        return { name, input, ref, output: { ref, ...wrapBuyerFields(d) }, is_error: false };
      }
      case "get_transaction": {
        const t = await reader.getTransaction(id("transaction_id"));
        const ref = `transaction:${t.id}`;
        return { name, input, ref, output: { ref, ...wrapTransactionBuyer(t) }, is_error: false };
      }
      case "get_order": {
        const o = await reader.getOrder(id("order_id"));
        const ref = `order:${o.id}`;
        return { name, input, ref, output: { ref, ...o }, is_error: false };
      }
      case "get_tracking": {
        const t = await reader.getTracking(id("transaction_id"));
        const ref = `tracking:${id("transaction_id")}`;
        const output = t ? { ref, found: true, ...t } : { ref, found: false };
        return { name, input, ref, output, is_error: false };
      }
      case "get_merchant_policies": {
        const p = merchant.getPolicies();
        return { name, input, ref: p.ref, output: p, is_error: false };
      }
      case "list_prior_disputes_for_buyer": {
        const h = merchant.priorHistory(id("buyer_id"), currentDisputeId);
        return { name, input, ref: h.ref, output: h, is_error: false };
      }
    }
  } catch (err) {
    const message = err instanceof PayPalError ? `${err.code}: ${err.message}` : String(err);
    return { name, input, ref: null, output: { error: message }, is_error: true };
  }
}

import {
  type LLM,
  type LLMRequest,
  type LLMResponse,
  RecordingLLM,
  ResponseCache,
} from "../src/agent/llm.js";
import { NvidiaLLM } from "../src/agent/nvidia.js";
import { runAgent } from "../src/agent/run.js";
import { SUBMIT_TOOL } from "../src/agent/tools.js";
import { LLM_CACHE_DIRS } from "../src/app.js";
import { DEMO_NOW } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { loadDotenv } from "../src/env.js";
import { createMerchantData } from "../src/merchant/data.js";
import { readOnly } from "../src/paypal/client.js";
import { MockPayPal, seedMock } from "../src/paypal/mock.js";
import { SCENARIOS, type Scenario } from "../src/seed/scenarios.js";
import { scriptedDraft } from "./scripted-drafts.js";

function scriptedLLM(s: Scenario): LLM {
  const txn = s.transaction.id;
  const plan: { name: string; input: unknown }[][] = [
    [{ name: "get_dispute", input: { dispute_id: s.dispute.dispute_id } }],
    [
      { name: "get_transaction", input: { transaction_id: txn } },
      { name: "get_tracking", input: { transaction_id: txn } },
      { name: "get_merchant_policies", input: {} },
      { name: "list_prior_disputes_for_buyer", input: { buyer_id: s.transaction.buyer.id } },
    ],
    [{ name: "get_order", input: { order_id: s.order.id } }],
    [{ name: SUBMIT_TOOL, input: scriptedDraft(s) }],
  ];
  return {
    label: "scripted-fixture",
    provenance: "scripted-fixture",
    source: "replayed",
    async create(req: LLMRequest): Promise<LLMResponse> {
      const turn = req.messages.filter((m) => m.role === "assistant").length;
      const step = plan[Math.min(turn, plan.length - 1)] ?? [];
      return {
        stop_reason: "tool_use",
        model: "scripted-fixture",
        content: step.map((call, i) => ({
          type: "tool_use" as const,
          id: `toolu_scripted_${turn}_${i}`,
          name: call.name,
          input: call.input,
        })),
      };
    },
  };
}

loadDotenv();
const nvidiaMode = process.argv[2] === "nvidia";

function recorder(scenario: Scenario): { llm: LLM; label: string } {
  if (!nvidiaMode) {
    const cache = new ResponseCache(LLM_CACHE_DIRS.scripted);
    return { llm: new RecordingLLM(scriptedLLM(scenario), cache), label: "scripted" };
  }
  const config = loadConfig({ ...process.env, LLM_PROVIDER: "" });
  if (!config.nvidiaApiKey) {
    console.error("NVIDIA_API_KEY is required for the nvidia mode. Add it to .env.");
    process.exit(1);
  }
  const cache = new ResponseCache(LLM_CACHE_DIRS.nvidia);
  const inner = new NvidiaLLM({ apiKey: config.nvidiaApiKey, model: config.nvidiaModel });
  return { llm: new RecordingLLM(inner, cache), label: config.nvidiaModel };
}

for (const scenario of SCENARIOS) {
  const db = openDb(":memory:");
  seedMock(db, SCENARIOS);
  const { llm, label } = recorder(scenario);
  const result = await runAgent({
    disputeId: scenario.dispute.dispute_id,
    reader: readOnly(new MockPayPal(db, SCENARIOS)),
    merchant: createMerchantData(db, SCENARIOS),
    llm,
    now: new Date(DEMO_NOW),
  });
  console.log(
    `${scenario.slug} [${label}]: ${result.state} ${result.draft?.recommendation ?? result.error} score=${result.score?.total}`,
  );
}

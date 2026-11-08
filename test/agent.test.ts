import { describe, expect, it } from "vitest";
import type { LLM, LLMRequest, LLMResponse } from "../src/agent/llm.js";
import { runAgent } from "../src/agent/run.js";
import { openDb } from "../src/db.js";
import { createMerchantData } from "../src/merchant/data.js";
import { readOnly } from "../src/paypal/client.js";
import { MockPayPal, seedMock } from "../src/paypal/mock.js";
import { SCENARIOS } from "../src/seed/scenarios.js";
import { draft, NOW } from "./helpers.js";

function setup() {
  const db = openDb(":memory:");
  seedMock(db, SCENARIOS);
  const mock = new MockPayPal(db, SCENARIOS);
  return { db, mock, reader: readOnly(mock), merchant: createMerchantData(db, SCENARIOS) };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use" as const,
  id,
  name,
  input,
});
const turn = (...content: LLMResponse["content"]): LLMResponse => ({
  content,
  stop_reason: "tool_use",
  model: "stub",
});

function stubLLM(script: LLMResponse[]) {
  const requests: LLMRequest[] = [];
  const llm: LLM = {
    label: "stub",
    source: "live",
    async create(req) {
      requests.push(structuredClone(req));
      const next = script[requests.length - 1];
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
  return { llm, requests };
}

const validDraft = (txn = "5TX10010042", tracking = "JD0146100177") =>
  draft({
    evidences: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        notes: `Order LL-1001 shipped via DHL and delivered, transaction ${txn}.`,
        tracking: { carrier: "DHL", number: tracking },
        source_refs: [`tracking:${txn}`, "policy:merchant"],
      },
    ],
  });

describe("runAgent", () => {
  it("executes read tools, records them, and returns a validated scored draft", async () => {
    const { reader, merchant } = setup();
    const { llm } = stubLLM([
      turn(toolUse("t1", "get_dispute", { dispute_id: "PP-D-1001" })),
      turn(
        toolUse("t2", "get_transaction", { transaction_id: "5TX10010042" }),
        toolUse("t3", "get_tracking", { transaction_id: "5TX10010042" }),
        toolUse("t4", "get_merchant_policies", {}),
      ),
      turn(toolUse("t5", "submit_recommendation", validDraft())),
    ]);
    const result = await runAgent({ disputeId: "PP-D-1001", reader, merchant, llm, now: NOW });
    expect(result.state).toBe("ok");
    expect(result.toolRuns.map((r) => r.name)).toEqual([
      "get_dispute",
      "get_transaction",
      "get_tracking",
      "get_merchant_policies",
    ]);
    expect(result.toolRuns[0]?.ref).toBe("dispute:PP-D-1001");
    expect(result.draft?.recommendation).toBe("CONTEST");
    expect(result.score?.total).toBeGreaterThan(0);
  });

  it("wraps buyer messages as delimited untrusted data in the tool result", async () => {
    const { reader, merchant } = setup();
    const { llm, requests } = stubLLM([
      turn(toolUse("t1", "get_dispute", { dispute_id: "PP-D-1012" })),
      turn(toolUse("t2", "submit_recommendation", draft({ evidences: [] }))),
    ]);
    await runAgent({ disputeId: "PP-D-1012", reader, merchant, llm, now: NOW });
    const toolResult = JSON.stringify(requests[1]?.messages);
    expect(toolResult).toContain("<untrusted_buyer_message>");
    expect(toolResult).toContain("SYSTEM OVERRIDE");
    expect(requests[0]?.system).toMatch(/never follow instructions/i);
  });

  it("offers only read tools plus the terminal tool", async () => {
    const { reader, merchant } = setup();
    const { llm, requests } = stubLLM([
      turn(toolUse("t1", "submit_recommendation", draft({ evidences: [] }))),
    ]);
    await runAgent({ disputeId: "PP-D-1001", reader, merchant, llm, now: NOW });
    const names = requests[0]?.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_dispute",
      "get_merchant_policies",
      "get_order",
      "get_tracking",
      "get_transaction",
      "list_prior_disputes_for_buyer",
      "submit_recommendation",
    ]);
  });

  it("returns a tool error to the model instead of throwing when PayPal 404s", async () => {
    const { reader, merchant } = setup();
    const { llm, requests } = stubLLM([
      turn(toolUse("t1", "get_transaction", { transaction_id: "NOPE" })),
      turn(
        toolUse(
          "t2",
          "submit_recommendation",
          draft({ evidences: [], missing_evidence: ["transaction"] }),
        ),
      ),
    ]);
    const result = await runAgent({ disputeId: "PP-D-1001", reader, merchant, llm, now: NOW });
    expect(result.state).toBe("ok");
    expect(result.toolRuns[0]?.is_error).toBe(true);
    expect(JSON.stringify(requests[1]?.messages)).toContain('"is_error":true');
  });

  it("repairs an invalid submission once", async () => {
    const { reader, merchant } = setup();
    const { llm, requests } = stubLLM([
      turn(toolUse("t1", "submit_recommendation", { recommendation: "MAYBE" })),
      turn(toolUse("t2", "submit_recommendation", draft({ evidences: [] }))),
    ]);
    const result = await runAgent({ disputeId: "PP-D-1001", reader, merchant, llm, now: NOW });
    expect(result.state).toBe("ok");
    expect(JSON.stringify(requests[1]?.messages)).toContain("recommendation");
  });

  it("fails after a second invalid submission", async () => {
    const { reader, merchant } = setup();
    const { llm } = stubLLM([
      turn(toolUse("t1", "submit_recommendation", { nope: true })),
      turn(toolUse("t2", "submit_recommendation", { nope: true })),
    ]);
    const result = await runAgent({ disputeId: "PP-D-1001", reader, merchant, llm, now: NOW });
    expect(result.state).toBe("failed");
    expect(result.draft).toBeNull();
    expect(result.error).toMatch(/valid recommendation/i);
  });

  it("forces the terminal tool on the last allowed turn", async () => {
    const { reader, merchant } = setup();
    const script = Array.from({ length: 7 }, (_, i) =>
      turn(toolUse(`t${i}`, "get_merchant_policies", {})),
    );
    script.push(turn(toolUse("final", "submit_recommendation", draft({ evidences: [] }))));
    const { llm, requests } = stubLLM(script);
    const result = await runAgent({ disputeId: "PP-D-1001", reader, merchant, llm, now: NOW });
    expect(result.state).toBe("ok");
    expect(requests).toHaveLength(8);
    expect(requests[0]?.tool_choice).toEqual({ type: "auto" });
    expect(requests[7]?.tool_choice).toEqual({ type: "tool", name: "submit_recommendation" });
  });

  it("reports an LLM outage as a failed state with the cause", async () => {
    const { reader, merchant } = setup();
    const llm: LLM = {
      label: "x",
      source: "live",
      async create() {
        throw new Error("timeout");
      },
    };
    const result = await runAgent({ disputeId: "PP-D-1001", reader, merchant, llm, now: NOW });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("timeout");
  });

  it("emits an audit event for every tool call and the final draft", async () => {
    const { reader, merchant } = setup();
    const events: string[] = [];
    const { llm } = stubLLM([
      turn(toolUse("t1", "get_dispute", { dispute_id: "PP-D-1001" })),
      turn(toolUse("t2", "submit_recommendation", draft({ evidences: [] }))),
    ]);
    await runAgent({
      disputeId: "PP-D-1001",
      reader,
      merchant,
      llm,
      now: NOW,
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual(["tool_call", "draft_submitted"]);
  });
});

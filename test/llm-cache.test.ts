import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LLM,
  type LLMRequest,
  type LLMResponse,
  RecordingLLM,
  ReplayLLM,
  ReplayMissError,
  ResponseCache,
  requestKey,
} from "../src/agent/llm.js";

const req = (text: string): LLMRequest => ({
  model: "claude-sonnet-5-5",
  system: "sys",
  messages: [{ role: "user", content: text }],
  tools: [],
  tool_choice: { type: "auto" },
  max_tokens: 100,
  temperature: 0,
});
const resp: LLMResponse = {
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  model: "claude-sonnet-5-5",
};

describe("response cache", () => {
  it("keys requests by content, not object identity or key order", () => {
    const a = req("x");
    const b = { ...req("x"), max_tokens: 100 };
    expect(requestKey(a)).toBe(requestKey(b));
    expect(requestKey(req("x"))).not.toBe(requestKey(req("y")));
  });

  it("records an inner response and replays it without the inner model", async () => {
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), "llm-")));
    let calls = 0;
    const inner: LLM = {
      label: "inner",
      source: "live",
      async create() {
        calls += 1;
        return resp;
      },
    };
    await new RecordingLLM(inner, cache, "anthropic").create(req("x"));
    const replayed = await new ReplayLLM(cache).create(req("x"));
    expect(replayed).toEqual({ ...resp, provenance: "anthropic" });
    expect(calls).toBe(1);
  });

  it("fails loudly on a cache miss instead of inventing a response", async () => {
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), "llm-")));
    await expect(new ReplayLLM(cache).create(req("unknown"))).rejects.toBeInstanceOf(
      ReplayMissError,
    );
  });
});

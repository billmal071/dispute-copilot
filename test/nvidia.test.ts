import { describe, expect, it } from "vitest";
import type { LLMRequest } from "../src/agent/llm.js";
import { NvidiaHttpError, NvidiaLLM, NvidiaResponseError } from "../src/agent/nvidia.js";

const KEY = "nvapi-SECRET-KEY-123";
const MODEL = "nvidia/test-model";

const baseReq: LLMRequest = {
  model: "claude-sonnet-5-5",
  system: "sys prompt",
  messages: [{ role: "user", content: "go" }],
  tools: [{ name: "get_x", description: "gets x", input_schema: { type: "object" } }],
  tool_choice: { type: "auto" },
  max_tokens: 100,
  temperature: 0,
};

interface Call {
  url: string;
  init: RequestInit;
  // biome-ignore lint/suspicious/noExplicitAny: parsed request body in assertions
  body: Record<string, any>;
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function choice(message: Record<string, unknown>, finish = "stop", model = MODEL) {
  return { model, choices: [{ index: 0, message, finish_reason: finish }] };
}

function harness(responses: (Response | Error)[], opts: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  const llm = new NvidiaLLM({
    apiKey: KEY,
    model: MODEL,
    fetch: fetchFn as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });
  return { llm, calls, sleeps };
}

describe("NvidiaLLM request translation", () => {
  it("posts to the NVIDIA chat completions endpoint with a bearer token and OpenAI-style tools", async () => {
    const { llm, calls } = harness([reply(choice({ content: "hi" }))]);
    await llm.create(baseReq);
    const call = calls[0];
    expect(call?.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    const headers = (call?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.body.model).toBe(MODEL);
    expect(call?.body.messages[0]).toEqual({ role: "system", content: "sys prompt" });
    expect(call?.body.messages[1]).toEqual({ role: "user", content: "go" });
    expect(call?.body.tools).toEqual([
      {
        type: "function",
        function: { name: "get_x", description: "gets x", parameters: { type: "object" } },
      },
    ]);
    expect(call?.body.tool_choice).toBe("auto");
    expect(call?.body.max_tokens).toBe(100);
    expect(call?.body.temperature).toBe(0);
  });

  it("maps a forced tool choice to a named function", async () => {
    const { llm, calls } = harness([reply(choice({ content: "x" }))]);
    await llm.create({ ...baseReq, tool_choice: { type: "tool", name: "get_x" } });
    expect(calls[0]?.body.tool_choice).toEqual({ type: "function", function: { name: "get_x" } });
  });

  it("translates assistant tool_use and user tool_result blocks", async () => {
    const { llm, calls } = harness([reply(choice({ content: "ok" }))]);
    await llm.create({
      ...baseReq,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking" },
            { type: "tool_use", id: "t1", name: "get_x", input: { a: 1 } },
            { type: "tool_use", id: "t2", name: "get_x", input: { a: 2 } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: '{"r":1}' },
            { type: "tool_result", tool_use_id: "t2", content: "bad", is_error: true },
          ],
        },
      ],
    });
    const msgs = calls[0]?.body.messages;
    expect(msgs[2]).toEqual({
      role: "assistant",
      content: "thinking",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "get_x", arguments: '{"a":1}' } },
        { id: "t2", type: "function", function: { name: "get_x", arguments: '{"a":2}' } },
      ],
    });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "t1", content: '{"r":1}' });
    expect(msgs[4]).toEqual({ role: "tool", tool_call_id: "t2", content: "bad" });
  });

  it("uses null content for an assistant turn that only calls tools", async () => {
    const { llm, calls } = harness([reply(choice({ content: "ok" }))]);
    await llm.create({
      ...baseReq,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_x", input: {} }] },
      ],
    });
    expect(calls[0]?.body.messages[2].content).toBeNull();
  });
});

describe("NvidiaLLM response translation", () => {
  it("turns tool_calls into tool_use blocks, including several in one turn", async () => {
    const { llm } = harness([
      reply(
        choice(
          {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "get_x", arguments: '{"a":1}' } },
              { id: "c2", type: "function", function: { name: "get_y", arguments: "{}" } },
            ],
          },
          "tool_calls",
        ),
      ),
    ]);
    const res = await llm.create(baseReq);
    expect(res.content).toEqual([
      { type: "tool_use", id: "c1", name: "get_x", input: { a: 1 } },
      { type: "tool_use", id: "c2", name: "get_y", input: {} },
    ]);
    expect(res.stop_reason).toBe("tool_use");
    expect(res.model).toBe(MODEL);
  });

  it("keeps text before tool calls and maps finish reasons", async () => {
    const { llm } = harness([
      reply(choice({ content: "done" }, "stop")),
      reply(choice({ content: "cut" }, "length")),
    ]);
    const a = await llm.create(baseReq);
    expect(a.content).toEqual([{ type: "text", text: "done" }]);
    expect(a.stop_reason).toBe("end_turn");
    expect((await llm.create(baseReq)).stop_reason).toBe("max_tokens");
  });

  it("raises a clear error for malformed tool arguments instead of crashing", async () => {
    const { llm } = harness([
      reply(
        choice(
          {
            tool_calls: [
              { id: "c1", type: "function", function: { name: "get_x", arguments: "{oops" } },
            ],
          },
          "tool_calls",
        ),
      ),
    ]);
    await expect(llm.create(baseReq)).rejects.toThrow(NvidiaResponseError);
    await expect(
      harness([
        reply(
          choice({
            tool_calls: [
              { id: "c1", type: "function", function: { name: "get_x", arguments: "{oops" } },
            ],
          }),
        ),
      ]).llm.create(baseReq),
    ).rejects.toThrow(/malformed JSON arguments for get_x/);
  });

  it("raises a clear error when there are no choices", async () => {
    const { llm } = harness([reply({ model: MODEL, choices: [] })]);
    await expect(llm.create(baseReq)).rejects.toThrow(/no choices/);
  });
});

describe("NvidiaLLM failure handling", () => {
  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const { llm, calls, sleeps } = harness([
      reply({ error: "slow down" }, 429),
      reply({ error: "boom" }, 503),
      reply(choice({ content: "ok" })),
    ]);
    const res = await llm.create(baseReq);
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  it("honours Retry-After on 429", async () => {
    const { llm, sleeps } = harness([
      reply({}, 429, { "retry-after": "2" }),
      reply(choice({ content: "ok" })),
    ]);
    await llm.create(baseReq);
    expect(sleeps[0]).toBe(2000);
  });

  it("gives up after the retry budget with the HTTP status", async () => {
    const { llm, calls } = harness([reply({}, 500), reply({}, 500), reply({}, 500)], {
      maxRetries: 2,
    });
    await expect(llm.create(baseReq)).rejects.toMatchObject({
      name: "NvidiaHttpError",
      status: 500,
    });
    expect(calls).toHaveLength(3);
  });

  it("does not retry other 4xx errors", async () => {
    const { llm, calls } = harness([reply({ detail: "bad key" }, 401)]);
    await expect(llm.create(baseReq)).rejects.toBeInstanceOf(NvidiaHttpError);
    expect(calls).toHaveLength(1);
  });

  it("retries network errors and times out hung requests", async () => {
    const { llm, calls } = harness([
      new TypeError("fetch failed"),
      reply(choice({ content: "ok" })),
    ]);
    await llm.create(baseReq);
    expect(calls).toHaveLength(2);

    const hung = new NvidiaLLM({
      apiKey: KEY,
      model: MODEL,
      timeoutMs: 10,
      maxRetries: 0,
      sleep: async () => {},
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(init.signal?.reason));
        })) as typeof fetch,
    });
    await expect(hung.create(baseReq)).rejects.toThrow(/timed out/);
  });

  it("never puts the key in an error message", async () => {
    const { llm } = harness([reply({ detail: `invalid key ${KEY}` }, 401)]);
    const err = (await llm.create(baseReq).catch((e) => e)) as Error;
    expect(String(err.message)).not.toContain(KEY);
    expect(String(err.message)).toContain("401");
  });
});

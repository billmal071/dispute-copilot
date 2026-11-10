import type { ContentBlock, LLM, LLMMessage, LLMRequest, LLMResponse } from "./llm.js";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NVIDIA_MODEL = "mistralai/mistral-large-4-1t-a52b";

export class NvidiaHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`NVIDIA API returned HTTP ${status}: ${detail}`);
    this.name = "NvidiaHttpError";
  }
}

export class NvidiaResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NvidiaResponseError";
  }
}

export interface NvidiaOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletion {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: ChatToolCall[] | null };
    finish_reason?: string | null;
  }[];
}

const FINISH_REASONS: Record<string, string> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  length: "max_tokens",
};

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

function toChatMessages(req: LLMRequest): unknown[] {
  const out: unknown[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) out.push(...translateMessage(m));
  return out;
}

function translateMessage(m: LLMMessage): unknown[] {
  if (typeof m.content === "string") return [{ role: m.role, content: m.content }];
  if (m.role === "assistant") {
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const calls = m.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    return [
      {
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      },
    ];
  }
  const out: unknown[] = [];
  for (const b of m.content) {
    if (b.type === "tool_result")
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
  }
  const text = m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (text !== "") out.push({ role: "user", content: text });
  return out;
}

function parseToolCall(call: ChatToolCall, index: number): ContentBlock {
  const name = call.function?.name;
  if (!name) throw new NvidiaResponseError("NVIDIA response contained a tool call with no name");
  const raw = call.function?.arguments;
  let input: unknown = {};
  if (raw !== undefined && raw.trim() !== "") {
    try {
      input = JSON.parse(raw);
    } catch {
      throw new NvidiaResponseError(
        `NVIDIA model returned malformed JSON arguments for ${name}: ${raw.slice(0, 120)}`,
      );
    }
  }
  return { type: "tool_use", id: call.id || `call_${index}`, name, input };
}

export class NvidiaLLM implements LLM {
  readonly label: string;
  readonly provenance: `nvidia:${string}`;
  readonly source = "live" as const;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: NvidiaOptions) {
    this.label = opts.model;
    this.provenance = `nvidia:${opts.model}`;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? NVIDIA_BASE_URL;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  async create(req: LLMRequest): Promise<LLMResponse> {
    const body = JSON.stringify({
      model: this.opts.model,
      messages: toChatMessages(req),
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
      tool_choice:
        req.tool_choice.type === "tool"
          ? { type: "function", function: { name: req.tool_choice.name } }
          : "auto",
      max_tokens: req.max_tokens,
      temperature: req.temperature,
    });
    const completion = await this.post(body);
    const choice = completion.choices?.[0];
    if (!choice?.message) throw new NvidiaResponseError("NVIDIA response contained no choices");
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    (choice.message.tool_calls ?? []).forEach((call, i) => {
      content.push(parseToolCall(call, i));
    });
    const reason = choice.finish_reason ?? null;
    return {
      content,
      stop_reason: reason === null ? null : (FINISH_REASONS[reason] ?? reason),
      model: completion.model ?? this.opts.model,
    };
  }

  private scrub(text: string): string {
    return text.split(this.opts.apiKey).join("[redacted]").slice(0, 300);
  }

  private async post(body: string): Promise<ChatCompletion> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return (await res.json()) as ChatCompletion;
        const detail = this.scrub(await res.text().catch(() => ""));
        lastError = new NvidiaHttpError(res.status, detail);
        if (res.status !== 429 && res.status < 500) throw lastError;
        const header = Number(res.headers.get("retry-after"));
        if (Number.isFinite(header) && header > 0) retryAfterMs = header * 1000;
      } catch (err) {
        if (err instanceof NvidiaHttpError && err.status < 500 && err.status !== 429) throw err;
        if (!(err instanceof NvidiaHttpError)) {
          const name = err instanceof Error ? err.name : "";
          lastError =
            name === "TimeoutError" || name === "AbortError"
              ? new Error(`NVIDIA request timed out after ${this.timeoutMs}ms`)
              : new Error(
                  `NVIDIA request failed: ${this.scrub(err instanceof Error ? err.message : String(err))}`,
                );
        }
      }
      if (attempt < this.maxRetries)
        await this.sleep(retryAfterMs ?? Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
    }
    throw lastError ?? new Error("NVIDIA request failed");
  }
}

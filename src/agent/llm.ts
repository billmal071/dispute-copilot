import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { canonicalJson, sha256 } from "../canonical.js";

export const MODEL = "claude-sonnet-5-5";

export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface LLMRequest {
  model: string;
  system: string;
  messages: LLMMessage[];
  tools: LLMTool[];
  tool_choice: { type: "auto" } | { type: "tool"; name: string };
  max_tokens: number;
  temperature: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  model: string;
}

export interface LLM {
  readonly label: string;
  readonly source: "live" | "replayed";
  create(req: LLMRequest): Promise<LLMResponse>;
}

export class ReplayMissError extends Error {
  constructor(readonly key: string) {
    super(
      "No scripted fixture for this dispute state. Add ANTHROPIC_API_KEY to draft it with a live model.",
    );
    this.name = "ReplayMissError";
  }
}

export function requestKey(req: LLMRequest): string {
  return sha256(canonicalJson(req));
}

export interface CacheEntry {
  key: string;
  source: "anthropic" | "scripted-fixture";
  recorded_at: string;
  response: LLMResponse;
}

export class ResponseCache {
  constructor(private readonly dir: string) {}

  private path(key: string) {
    return join(this.dir, `${key}.json`);
  }

  get(key: string): CacheEntry | null {
    const p = this.path(key);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CacheEntry) : null;
  }

  put(entry: CacheEntry): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(entry.key), `${JSON.stringify(entry, null, 2)}\n`);
  }
}

export class ReplayLLM implements LLM {
  readonly label = "replayed";
  readonly source = "replayed" as const;

  constructor(private readonly cache: ResponseCache) {}

  async create(req: LLMRequest): Promise<LLMResponse> {
    const key = requestKey(req);
    const hit = this.cache.get(key);
    if (!hit) throw new ReplayMissError(key);
    return hit.response;
  }
}

export class RecordingLLM implements LLM {
  readonly label: string;
  readonly source: "live" | "replayed";

  constructor(
    private readonly inner: LLM,
    private readonly cache: ResponseCache,
    private readonly recordedAs: CacheEntry["source"],
  ) {
    this.label = inner.label;
    this.source = inner.source;
  }

  async create(req: LLMRequest): Promise<LLMResponse> {
    const response = await this.inner.create(req);
    this.cache.put({
      key: requestKey(req),
      source: this.recordedAs,
      recorded_at: new Date().toISOString(),
      response,
    });
    return response;
  }
}

export interface AnthropicLike {
  messages: {
    create(params: any): Promise<{ content: any[]; stop_reason: string | null; model: string }>;
  };
}

export class AnthropicLLM implements LLM {
  readonly label = MODEL;
  readonly source = "live" as const;
  private readonly client: AnthropicLike;

  constructor(apiKeyOrClient: string | AnthropicLike) {
    this.client =
      typeof apiKeyOrClient === "string"
        ? (new Anthropic({ apiKey: apiKeyOrClient }) as unknown as AnthropicLike)
        : apiKeyOrClient;
  }

  async create(req: LLMRequest): Promise<LLMResponse> {
    const res = await this.client.messages.create({
      model: req.model,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      tool_choice: req.tool_choice,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
    });
    const content: ContentBlock[] = res.content.flatMap((b): ContentBlock[] => {
      if (b.type === "text") return [{ type: "text", text: b.text }];
      if (b.type === "tool_use")
        return [{ type: "tool_use", id: b.id, name: b.name, input: b.input }];
      return [];
    });
    return { content, stop_reason: res.stop_reason, model: res.model };
  }
}

export function createLLM(apiKey: string | undefined, cacheDir: string): LLM {
  const cache = new ResponseCache(cacheDir);
  if (apiKey) return new RecordingLLM(new AnthropicLLM(apiKey), cache, "anthropic");
  return new ReplayLLM(cache);
}

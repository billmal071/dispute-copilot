import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { canonicalJson, sha256 } from "../canonical.js";
import { DEFAULT_NVIDIA_MODEL, NvidiaLLM } from "./nvidia.js";

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

export type CacheSource =
  | "scripted-fixture"
  | "anthropic"
  | `anthropic:${string}`
  | `nvidia:${string}`;

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  model: string;
  provenance?: CacheSource;
}

export interface LLM {
  readonly label: string;
  readonly source: "live" | "replayed";
  readonly provenance?: CacheSource;
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
  source: CacheSource;
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
    if (!existsSync(p)) return null;
    const entry = JSON.parse(readFileSync(p, "utf8")) as Omit<CacheEntry, "source"> & {
      source?: CacheSource;
    };
    return { ...entry, source: entry.source ?? "scripted-fixture" };
  }

  put(entry: CacheEntry): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(entry.key), `${JSON.stringify(entry, null, 2)}\n`);
  }
}

export class ReplayLLM implements LLM {
  readonly label = "replayed";
  readonly source = "replayed" as const;
  private readonly caches: ResponseCache[];

  constructor(caches: ResponseCache | ResponseCache[]) {
    this.caches = Array.isArray(caches) ? caches : [caches];
  }

  lookup(key: string): CacheEntry | null {
    for (const cache of this.caches) {
      const hit = cache.get(key);
      if (hit) return hit;
    }
    return null;
  }

  async create(req: LLMRequest): Promise<LLMResponse> {
    const key = requestKey(req);
    const hit = this.lookup(key);
    if (!hit) throw new ReplayMissError(key);
    return { ...hit.response, provenance: hit.source };
  }
}

export class RecordingLLM implements LLM {
  readonly label: string;
  readonly source: "live" | "replayed";
  readonly provenance: CacheSource | undefined;

  constructor(
    private readonly inner: LLM,
    private readonly cache: ResponseCache,
    private readonly recordedAs: CacheSource | undefined = inner.provenance,
  ) {
    this.label = inner.label;
    this.source = inner.source;
    this.provenance = inner.provenance;
  }

  async create(req: LLMRequest): Promise<LLMResponse> {
    const response = await this.inner.create(req);
    this.cache.put({
      key: requestKey(req),
      source: this.recordedAs ?? "scripted-fixture",
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
  readonly provenance = `anthropic:${MODEL}` as const;
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

export interface LLMSettings {
  provider: "anthropic" | "nvidia" | "replay";
  anthropicApiKey?: string | undefined;
  nvidiaApiKey?: string | undefined;
  nvidiaModel?: string | undefined;
}

export interface CacheDirs {
  scripted: string;
  nvidia: string;
  anthropic: string;
}

export function createLLM(settings: LLMSettings, dirs: CacheDirs): LLM {
  if (settings.provider === "anthropic") {
    if (!settings.anthropicApiKey)
      throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    return new RecordingLLM(
      new AnthropicLLM(settings.anthropicApiKey),
      new ResponseCache(dirs.anthropic),
    );
  }
  if (settings.provider === "nvidia") {
    if (!settings.nvidiaApiKey) throw new Error("LLM_PROVIDER=nvidia requires NVIDIA_API_KEY");
    return new RecordingLLM(
      new NvidiaLLM({
        apiKey: settings.nvidiaApiKey,
        model: settings.nvidiaModel ?? DEFAULT_NVIDIA_MODEL,
      }),
      new ResponseCache(dirs.nvidia),
    );
  }
  return new ReplayLLM([
    new ResponseCache(dirs.nvidia),
    new ResponseCache(dirs.anthropic),
    new ResponseCache(dirs.scripted),
  ]);
}

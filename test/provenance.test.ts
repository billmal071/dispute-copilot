import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLLM,
  type LLMRequest,
  type LLMResponse,
  RecordingLLM,
  ReplayLLM,
  ResponseCache,
  requestKey,
} from "../src/agent/llm.js";
import { NvidiaLLM } from "../src/agent/nvidia.js";
import { provenanceLabel } from "../src/agent/provenance.js";
import { runAgent } from "../src/agent/run.js";
import { DEMO_NOW } from "../src/clock.js";
import { openDb } from "../src/db.js";
import { renderResults, runEval } from "../src/eval/run.js";
import { createMerchantData } from "../src/merchant/data.js";
import { readOnly } from "../src/paypal/client.js";
import { MockPayPal, seedMock } from "../src/paypal/mock.js";
import { SCENARIOS } from "../src/seed/scenarios.js";
import { createServer } from "../src/server.js";
import { makeApp } from "./app-helpers.js";
import { startSession, withSession } from "./csrf-helpers.js";

const req: LLMRequest = {
  model: "claude-sonnet-5-5",
  system: "sys",
  messages: [{ role: "user", content: "x" }],
  tools: [],
  tool_choice: { type: "auto" },
  max_tokens: 10,
  temperature: 0,
};
const resp: LLMResponse = {
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  model: "m",
};

function dirWith(entry: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    write: (key: string) =>
      writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, ...entry })),
  };
}

function entry(source: string | undefined): Record<string, unknown> {
  return { ...(source ? { source } : {}), recorded_at: "2026-01-01T00:00:00Z", response: resp };
}

describe("provenanceLabel", () => {
  it("labels scripted fixtures as scripted, not real Claude output", () => {
    const l = provenanceLabel("scripted-fixture", "replayed");
    expect(l.chip).toBe("Scripted demo fixture");
    expect(l.note).toMatch(/not real Claude output/);
  });

  it("treats legacy replayed rows as scripted fixtures", () => {
    expect(provenanceLabel("replayed", "replayed").chip).toBe("Scripted demo fixture");
  });

  it("labels a live NVIDIA draft with the real model name", () => {
    const l = provenanceLabel("nvidia:nvidia/some-model", "live");
    expect(l.chip).toBe("Real model: nvidia/some-model via NVIDIA, live");
    expect(l.note).toBeNull();
  });

  it("labels replayed NVIDIA recordings as recorded real model output, not scripted or live", () => {
    const l = provenanceLabel("nvidia:nvidia/some-model", "replayed");
    expect(l.chip).toBe("Recorded real model output: nvidia/some-model");
    expect(l.chip).not.toMatch(/scripted|live/i);
    expect(l.note).toBeNull();
  });

  it("labels Anthropic drafts live or recorded, and keeps legacy live rows readable", () => {
    expect(provenanceLabel("anthropic:claude-x", "live").chip).toBe("Live · claude-x");
    expect(provenanceLabel("anthropic:claude-x", "replayed").chip).toBe(
      "Recorded real model output: claude-x",
    );
    expect(provenanceLabel("claude-sonnet-5-5", "live").chip).toBe("Live · claude-sonnet-5-5");
  });
});

describe("cache entry source", () => {
  it("replays the source recorded in the cache entry", async () => {
    const { dir, write } = dirWith(entry("nvidia:nvidia/some-model"));
    const key = "k1";
    write(key);
    const cache = new ResponseCache(dir);
    expect(cache.get(key)?.source).toBe("nvidia:nvidia/some-model");
    const llm = new ReplayLLM(cache);
    expect(llm.lookup(key)?.source).toBe("nvidia:nvidia/some-model");
  });

  it("treats an entry with no source as a scripted fixture", () => {
    const { dir, write } = dirWith(entry(undefined));
    write("old");
    expect(new ResponseCache(dir).get("old")?.source).toBe("scripted-fixture");
  });

  it("records the inner provenance as the entry source", async () => {
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), "rec-")));
    const inner = new NvidiaLLM({
      apiKey: "k",
      model: "nvidia/m",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            model: "nvidia/m",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        )) as typeof fetch,
    });
    await new RecordingLLM(inner, cache).create(req);
    expect(cache.get(requestKey(req))?.source).toBe("nvidia:nvidia/m");
  });

  it("searches several caches in order and reports the source of the one that hit", async () => {
    const a = dirWith(entry("nvidia:nvidia/m"));
    const b = dirWith(entry("scripted-fixture"));
    a.write("in-a");
    b.write("in-b");
    const keyed = (key: string) =>
      new ReplayLLM([new ResponseCache(a.dir), new ResponseCache(b.dir)]).lookup(key);
    expect(keyed("in-a")?.source).toBe("nvidia:nvidia/m");
    expect(keyed("in-b")?.source).toBe("scripted-fixture");
    expect(keyed("missing")).toBeNull();
  });
});

describe("agent results carry the provenance", () => {
  async function run(llm: ReplayLLM) {
    const s = SCENARIOS[0];
    if (!s) throw new Error("no scenario");
    const db = openDb(":memory:");
    seedMock(db, SCENARIOS);
    return runAgent({
      disputeId: s.dispute.dispute_id,
      reader: readOnly(new MockPayPal(db, SCENARIOS)),
      merchant: createMerchantData(db, SCENARIOS),
      llm,
      now: new Date(DEMO_NOW),
    });
  }

  it("reports scripted-fixture for the shipped cache", async () => {
    const { cacheDir } = await import("./app-helpers.js");
    const result = await run(new ReplayLLM(new ResponseCache(cacheDir)));
    expect(result.model).toBe("scripted-fixture");
    expect(result.source).toBe("replayed");
  });

  it("reports the entry source when a non-scripted recording is replayed", async () => {
    const { cacheDir } = await import("./app-helpers.js");
    const shipped = new ResponseCache(cacheDir);
    const relabelled = {
      get: (k: string) => {
        const e = shipped.get(k);
        return e ? { ...e, source: "nvidia:nvidia/m" } : null;
      },
    } as unknown as ResponseCache;
    const result = await run(new ReplayLLM(relabelled));
    expect(result.model).toBe("nvidia:nvidia/m");
    expect(result.source).toBe("replayed");
  });
});

describe("createLLM provider selection", () => {
  const dirs = {
    scripted: "/nonexistent/scripted",
    nvidia: "/nonexistent/nvidia",
    anthropic: "/nonexistent/anthropic",
  };

  it("uses the configured provider", () => {
    expect(createLLM({ provider: "replay" }, dirs)).toBeInstanceOf(ReplayLLM);
    const nv = createLLM({ provider: "nvidia", nvidiaApiKey: "k", nvidiaModel: "nvidia/m" }, dirs);
    expect(nv.provenance).toBe("nvidia:nvidia/m");
    expect(nv.source).toBe("live");
    const an = createLLM({ provider: "anthropic", anthropicApiKey: "k" }, dirs);
    expect(an.provenance).toBe("anthropic:claude-sonnet-5-5");
  });

  it("refuses a provider whose key is missing", () => {
    expect(() => createLLM({ provider: "nvidia" }, dirs)).toThrow(/NVIDIA_API_KEY/);
    expect(() => createLLM({ provider: "anthropic" }, dirs)).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("UI and eval labels", () => {
  it("renders recorded NVIDIA output without calling it scripted or live", async () => {
    const app = await makeApp();
    const ctx = { mode: "mock" as const, ...app, verify: async () => true };
    const raw = createServer(ctx);
    const server = withSession(raw, await startSession(raw));
    await server.request("/disputes/PP-D-1001/draft", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
      body: "",
    });
    app.db.prepare("UPDATE drafts SET model = 'nvidia:nvidia/m'").run();
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    expect(html).toContain("Recorded real model output: nvidia/m");
    expect(html).not.toContain("Scripted demo fixture");
    expect(html).not.toContain("not real Claude output");
  });

  it("states real model output in the eval report when the run was not scripted", async () => {
    const md = renderResults({ ...(await runEval()), provenance: "nvidia:nvidia/m" });
    expect(md).toContain("Recorded real model output");
    expect(md).not.toContain("scripted fixtures");
  });
});

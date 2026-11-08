import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/app.js";
import { createServer } from "../src/server.js";
import { makeApp } from "./app-helpers.js";
import { startSession, withSession } from "./csrf-helpers.js";

const root = join(import.meta.dirname, "..");
const cacheDir = join(root, "fixtures", "llm-cache");

describe("demo fixtures are not presented as real model output", () => {
  it("no recorded fixture claims the real model", () => {
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const entry = JSON.parse(readFileSync(join(cacheDir, f), "utf8"));
      expect(entry.source).toBe("scripted-fixture");
      expect(entry.response.model).toBe("scripted-fixture");
    }
  });

  it("the cache builder does not label its fake LLM live or as the real model", () => {
    const src = readFileSync(join(root, "scripts", "build-llm-cache.ts"), "utf8");
    expect(src).not.toContain("claude-sonnet-5-5");
    expect(src).not.toMatch(/source:\s*"live"/);
  });

  it("the UI chip says scripted demo fixture and does not say recording", async () => {
    const app = await makeApp();
    const ctx: AppContext = { mode: "mock", ...app, verify: async () => true };
    const raw = createServer(ctx);
    const server = withSession(raw, await startSession(raw));
    const res = await server.request("/disputes/PP-D-1001/draft", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
      body: "",
    });
    const html = await res.text();
    expect(html).toContain("Scripted demo fixture");
    expect(html).not.toMatch(/Replayed recording/i);
    expect(html).toMatch(/not real Claude output/i);
  });

  it("the README says scripted demo fixture and explains demo vs live", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("Demo fixtures vs live model");
    const quickStart = readme.slice(
      readme.indexOf("## Quick start"),
      readme.indexOf("## Commands"),
    );
    expect(quickStart).toContain("scripted demo fixture");
    expect(quickStart).not.toMatch(/recorded model responses|Replayed recording/);
  });
});

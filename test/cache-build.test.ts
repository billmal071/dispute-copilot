import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("cache builder nvidia mode", () => {
  it("refuses to run without NVIDIA_API_KEY and records nothing", () => {
    const dir = join(root, "fixtures", "llm-cache-nvidia");
    const before = existsSync(dir) ? readdirSync(dir).sort() : null;
    const env = { ...process.env, NVIDIA_API_KEY: "", LLM_PROVIDER: "", MODE: "mock" };
    const res = spawnSync("npx", ["tsx", "scripts/build-llm-cache.ts", "nvidia"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/NVIDIA_API_KEY/);
    expect(existsSync(dir) ? readdirSync(dir).sort() : null).toEqual(before);
  });
});

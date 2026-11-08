import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadDotenv } from "../src/env.js";
import { listen } from "../src/listen.js";

function tempEnv(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "dotenv-")), ".env");
  writeFileSync(path, contents);
  return path;
}

describe("loadDotenv", () => {
  const keys = ["MODE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PORT"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("makes .env values visible to loadConfig without overriding real env vars", () => {
    for (const k of keys) delete process.env[k];
    process.env.PORT = "5555";
    loadDotenv(
      tempEnv("PORT=4444\nMODE=sandbox\nPAYPAL_CLIENT_ID=id\nPAYPAL_CLIENT_SECRET=secret\n"),
    );
    const cfg = loadConfig(process.env);
    expect(cfg.mode).toBe("sandbox");
    expect(cfg.paypal.clientId).toBe("id");
    expect(cfg.port).toBe(5555);
  });

  it("does nothing when there is no .env file", () => {
    expect(loadDotenv(join(tmpdir(), "definitely-missing", ".env"))).toBe(false);
  });
});

describe("startup failures are explicit", () => {
  it("names every missing sandbox credential", () => {
    expect(() => loadConfig({ MODE: "sandbox" })).toThrow(
      /PAYPAL_CLIENT_ID.*PAYPAL_CLIENT_SECRET/s,
    );
  });

  it("reports a port that is already taken instead of crashing with EADDRINUSE", async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(listen(() => new Response("ok"), port, "127.0.0.1")).rejects.toThrow(
        new RegExp(`port ${port}.*already in use`, "i"),
      );
    } finally {
      blocker.close();
    }
  });
});

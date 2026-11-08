import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to mock mode with no credentials", () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe("mock");
    expect(cfg.port).toBe(3000);
    expect(cfg.anthropicApiKey).toBeUndefined();
  });

  it("binds to loopback unless HOST says otherwise", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("treats empty strings from a copied .env.example as unset", () => {
    const cfg = loadConfig({ MODE: "mock", ANTHROPIC_API_KEY: "", PAYPAL_CLIENT_ID: "" });
    expect(cfg.anthropicApiKey).toBeUndefined();
  });

  it("requires PayPal credentials in sandbox mode and names the missing variable", () => {
    expect(() => loadConfig({ MODE: "sandbox" })).toThrow(/PAYPAL_CLIENT_ID/);
  });

  it("accepts a complete sandbox config", () => {
    const cfg = loadConfig({ MODE: "sandbox", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s" });
    expect(cfg.mode).toBe("sandbox");
    expect(cfg.paypal.env).toBe("sandbox");
  });

  it("rejects an unknown mode", () => {
    expect(() => loadConfig({ MODE: "live" })).toThrow();
  });
});

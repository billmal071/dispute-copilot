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

  describe("LLM provider", () => {
    it("defaults to replay with no keys", () => {
      expect(loadConfig({}).llmProvider).toBe("replay");
    });

    it("prefers anthropic, then nvidia, when no provider is named", () => {
      expect(loadConfig({ ANTHROPIC_API_KEY: "a", NVIDIA_API_KEY: "n" }).llmProvider).toBe(
        "anthropic",
      );
      expect(loadConfig({ NVIDIA_API_KEY: "n" }).llmProvider).toBe("nvidia");
    });

    it("lets LLM_PROVIDER override the key-based default", () => {
      const cfg = loadConfig({ LLM_PROVIDER: "replay", NVIDIA_API_KEY: "n" });
      expect(cfg.llmProvider).toBe("replay");
      expect(
        loadConfig({ LLM_PROVIDER: "nvidia", ANTHROPIC_API_KEY: "a", NVIDIA_API_KEY: "n" })
          .llmProvider,
      ).toBe("nvidia");
    });

    it("rejects an explicit provider whose key is missing, naming the variable", () => {
      expect(() => loadConfig({ LLM_PROVIDER: "nvidia" })).toThrow(/NVIDIA_API_KEY/);
      expect(() => loadConfig({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
      expect(() => loadConfig({ LLM_PROVIDER: "gpt" })).toThrow();
    });

    it("defaults the NVIDIA model and lets NVIDIA_MODEL override it", () => {
      expect(loadConfig({}).nvidiaModel).toBe("mistralai/mistral-large-4-1t-a52b");
      expect(loadConfig({ NVIDIA_MODEL: "meta/other" }).nvidiaModel).toBe("meta/other");
      expect(loadConfig({ NVIDIA_MODEL: "" }).nvidiaModel).toBe(
        "mistralai/mistral-large-4-1t-a52b",
      );
    });

    it("treats an empty NVIDIA_API_KEY as unset", () => {
      const cfg = loadConfig({ NVIDIA_API_KEY: "" });
      expect(cfg.nvidiaApiKey).toBeUndefined();
      expect(cfg.llmProvider).toBe("replay");
    });
  });
});

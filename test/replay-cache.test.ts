import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayLLM, ResponseCache } from "../src/agent/llm.js";
import { runAgent } from "../src/agent/run.js";
import { DEMO_NOW } from "../src/clock.js";
import { openDb } from "../src/db.js";
import { createMerchantData } from "../src/merchant/data.js";
import { readOnly } from "../src/paypal/client.js";
import { MockPayPal, seedMock } from "../src/paypal/mock.js";
import { SCENARIOS } from "../src/seed/scenarios.js";

const cacheDir = join(import.meta.dirname, "..", "fixtures", "llm-cache");

async function replay(slug: string) {
  const scenario = SCENARIOS.find((s) => s.slug === slug);
  if (!scenario) throw new Error(slug);
  const db = openDb(":memory:");
  seedMock(db, SCENARIOS);
  return runAgent({
    disputeId: scenario.dispute.dispute_id,
    reader: readOnly(new MockPayPal(db, SCENARIOS)),
    merchant: createMerchantData(db, SCENARIOS),
    llm: new ReplayLLM(new ResponseCache(cacheDir)),
    now: new Date(DEMO_NOW),
  });
}

describe("recorded responses cover every seeded scenario", () => {
  it.each(SCENARIOS.map((s) => [s.slug, s] as const))(
    "%s replays to the expected action without a key",
    async (slug, scenario) => {
      const result = await replay(slug);
      expect(result.error).toBeUndefined();
      expect(result.state).toBe("ok");
      expect(result.source).toBe("replayed");
      expect(result.draft?.recommendation).toBe(scenario.truth.expected_action);
      expect(result.score?.warnings).toEqual([]);
    },
  );

  it("flags the prompt-injection attempt instead of following it", async () => {
    const result = await replay("prompt-injection-buyer-message");
    expect(result.draft?.recommendation).toBe("CONTEST");
    expect(result.draft?.flags?.join(" ")).toMatch(/instruction/i);
  });

  it("lists what the merchant must supply when tracking is missing", async () => {
    const result = await replay("missing-tracking-needs-merchant");
    expect(result.draft?.missing_evidence.length).toBeGreaterThan(0);
    expect(result.score?.total).toBeLessThan(60);
  });

  it("scores a clean contest highly and a late response lower", async () => {
    const strong = await replay("not-received-delivered-signed");
    const late = await replay("late-response-under-24h");
    expect(strong.score?.total).toBe(100);
    expect(late.score?.total).toBe(90);
  });
});

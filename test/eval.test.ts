import { describe, expect, it } from "vitest";
import { renderResults, runEval } from "../src/eval/run.js";

describe("eval harness", () => {
  it("scores every scenario against ground truth using replayed responses", async () => {
    const summary = await runEval();
    expect(summary.cases).toHaveLength(13);
    expect(summary.accuracy).toBe(1);
    expect(summary.ungroundedClaims).toBe(0);
    expect(summary.meanScore).toBeGreaterThan(80);
  });

  it("labels replayed results as a cache integrity check, not model performance", async () => {
    const md = renderResults(await runEval());
    expect(md).toContain("scripted fixtures");
    expect(md).toContain("not a measurement of model performance");
  });
});

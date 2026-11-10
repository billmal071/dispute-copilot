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

  it("leaves non-contest cases unscored and out of the mean", async () => {
    const summary = await runEval();
    const noContest = summary.cases.filter((c) => c.actual !== "CONTEST");
    expect(noContest.length).toBeGreaterThan(0);
    expect(noContest.every((c) => c.score === null)).toBe(true);
    const contests = summary.cases.filter((c) => c.score !== null);
    const mean = contests.reduce((s, c) => s + (c.score ?? 0), 0) / contests.length;
    expect(summary.meanScore).toBeCloseTo(mean);
    expect(renderResults(summary)).toContain("| n/a |");
  });

  it("labels replayed results as a cache integrity check, not model performance", async () => {
    const md = renderResults(await runEval());
    expect(md).toContain("scripted fixtures");
    expect(md).toContain("not a measurement of model performance");
  });
});

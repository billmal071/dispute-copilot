import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLLM, type LLM, ReplayLLM, ResponseCache } from "../agent/llm.js";
import { runAgent } from "../agent/run.js";
import { LLM_CACHE_DIR, LLM_CACHE_DIRS } from "../app.js";
import { DEMO_NOW } from "../clock.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { createMerchantData } from "../merchant/data.js";
import { readOnly } from "../paypal/client.js";
import { MockPayPal, seedMock } from "../paypal/mock.js";
import { SCENARIOS } from "../seed/scenarios.js";

export interface EvalCase {
  slug: string;
  expected: string;
  actual: string | null;
  correct: boolean;
  score: number | null;
  ungrounded: number;
  source: string;
}

export interface EvalSummary {
  cases: EvalCase[];
  accuracy: number;
  meanScore: number;
  ungroundedClaims: number;
  live: boolean;
  provenance: string;
}

export async function runEval(
  llm: LLM = new ReplayLLM(new ResponseCache(LLM_CACHE_DIR)),
): Promise<EvalSummary> {
  const cases: EvalCase[] = [];
  let provenance = "scripted-fixture";
  for (const s of SCENARIOS) {
    const db = openDb(":memory:");
    seedMock(db, SCENARIOS);
    const result = await runAgent({
      disputeId: s.dispute.dispute_id,
      reader: readOnly(new MockPayPal(db, SCENARIOS)),
      merchant: createMerchantData(db, SCENARIOS),
      llm,
      now: new Date(DEMO_NOW),
    });
    provenance = result.model;
    cases.push({
      slug: s.slug,
      expected: s.truth.expected_action,
      actual: result.draft?.recommendation ?? null,
      correct: result.draft?.recommendation === s.truth.expected_action,
      score: result.score?.total ?? null,
      ungrounded: result.score?.warnings.length ?? 0,
      source: result.source,
    });
  }
  const scored = cases.filter((c) => c.score !== null);
  return {
    cases,
    accuracy: cases.filter((c) => c.correct).length / cases.length,
    meanScore: scored.reduce((sum, c) => sum + (c.score ?? 0), 0) / Math.max(1, scored.length),
    ungroundedClaims: cases.reduce((sum, c) => sum + c.ungrounded, 0),
    live: llm.source === "live",
    provenance,
  };
}

export function renderResults(s: EvalSummary): string {
  const real = /^(nvidia|anthropic):/.test(s.provenance);
  const model = s.provenance.slice(s.provenance.indexOf(":") + 1);
  const note = s.live
    ? `Live responses from ${model} on the seeded scenarios. Single run, agent only; the baseline comparison is not built yet.`
    : real
      ? `Recorded real model output from ${model}, replayed offline. Single run, agent only; the baseline comparison is not built yet.`
      : "Replayed scripted fixtures, so this is a cache integrity check and not a measurement of model performance. Set NVIDIA_API_KEY or ANTHROPIC_API_KEY and rerun for real model numbers.";
  const rows = s.cases
    .map(
      (c) =>
        `| ${c.slug} | ${c.expected} | ${c.actual ?? "failed"} | ${c.score ?? (c.actual ? "n/a" : "-")} | ${c.ungrounded} |`,
    )
    .join("\n");
  return `# Eval results\n\n${note}\n\n- Recommendation accuracy: ${(s.accuracy * 100).toFixed(0)}%\n- Mean evidence-quality score (contests only): ${s.meanScore.toFixed(1)}\n- Ungrounded claims: ${s.ungroundedClaims}\n\n| Scenario | Expected | Agent | Score | Ungrounded |\n|---|---|---|---|---|\n${rows}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig(process.env);
  const summary = await runEval(
    createLLM(
      {
        provider: config.llmProvider,
        anthropicApiKey: config.anthropicApiKey,
        nvidiaApiKey: config.nvidiaApiKey,
        nvidiaModel: config.nvidiaModel,
      },
      LLM_CACHE_DIRS,
    ),
  );
  const md = renderResults(summary);
  mkdirSync("eval", { recursive: true });
  writeFileSync(join("eval", "results.md"), md);
  console.log(md);
}

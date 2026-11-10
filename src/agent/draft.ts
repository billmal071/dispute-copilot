import { appendAudit } from "../audit.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import type { MerchantData } from "../merchant/data.js";
import type { ReadOnlyPayPalClient } from "../paypal/client.js";
import type { EvidenceDraft, ToolRun } from "../types.js";
import type { LLM } from "./llm.js";
import { runAgent } from "./run.js";
import type { ScoreResult } from "./score.js";

export interface DraftDeps {
  db: Db;
  reader: ReadOnlyPayPalClient;
  merchant: MerchantData;
  llm: LLM;
  clock: Clock;
}

export interface StoredDraft {
  id: number;
  dispute_id: string;
  version: number;
  draft: EvidenceDraft;
  score: number;
  scoreResult: ScoreResult;
  trace: ToolRun[];
  model: string;
  source: "live" | "replayed";
  created_at: string;
}

interface DraftRow {
  id: number;
  dispute_id: string;
  version: number;
  json: string;
  score: number;
  score_json: string;
  trace_json: string;
  model: string;
  source: string;
  created_at: string;
}

function hydrate(r: DraftRow): StoredDraft {
  return {
    id: r.id,
    dispute_id: r.dispute_id,
    version: r.version,
    draft: JSON.parse(r.json) as EvidenceDraft,
    score: r.score,
    scoreResult: JSON.parse(r.score_json) as ScoreResult,
    trace: JSON.parse(r.trace_json) as ToolRun[],
    model: r.model,
    source: r.source as StoredDraft["source"],
    created_at: r.created_at,
  };
}

export function getDraft(db: Db, id: number): StoredDraft | null {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
  return row ? hydrate(row) : null;
}

export function latestDraft(db: Db, disputeId: string): StoredDraft | null {
  const row = db
    .prepare("SELECT * FROM drafts WHERE dispute_id = ? ORDER BY version DESC LIMIT 1")
    .get(disputeId) as DraftRow | undefined;
  return row ? hydrate(row) : null;
}

export type DraftOutcome = { state: "ok"; draft: StoredDraft } | { state: "failed"; error: string };

export async function createDraft(deps: DraftDeps, disputeId: string): Promise<DraftOutcome> {
  const { db, clock } = deps;
  const ts = () => clock.now().toISOString();
  const result = await runAgent({
    disputeId,
    reader: deps.reader,
    merchant: deps.merchant,
    llm: deps.llm,
    now: clock.now(),
    onEvent: (event, payload) =>
      appendAudit(db, { actor: "agent", event, disputeId, payload, ts: ts() }),
  });

  if (result.state !== "ok" || !result.draft || !result.score) {
    const error = result.error ?? "The agent did not produce a draft.";
    appendAudit(db, {
      actor: "system",
      event: "draft_failed",
      disputeId,
      payload: { error },
      ts: ts(),
    });
    return { state: "failed", error };
  }

  const last = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM drafts WHERE dispute_id = ?")
    .get(disputeId) as { v: number };
  const created_at = ts();
  const info = db
    .prepare(
      `INSERT INTO drafts (dispute_id, version, json, score, score_json, trace_json, model, source, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
    )
    .run(
      disputeId,
      last.v + 1,
      JSON.stringify(result.draft),
      result.score.total ?? 0,
      JSON.stringify(result.score),
      JSON.stringify(result.toolRuns),
      result.model,
      result.source,
      created_at,
    );
  const stored = getDraft(db, Number(info.lastInsertRowid));
  if (!stored) throw new Error("draft vanished after insert");
  appendAudit(db, {
    actor: "agent",
    event: "draft_stored",
    disputeId,
    payload: {
      draft_id: stored.id,
      version: stored.version,
      score: stored.score,
      source: stored.source,
    },
    ts: created_at,
  });
  return { state: "ok", draft: stored };
}

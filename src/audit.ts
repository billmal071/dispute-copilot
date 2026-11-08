import { canonicalJson, sha256 } from "./canonical.js";
import type { Db } from "./db.js";

export type AuditActor = "agent" | "human" | "system" | "paypal";

export interface AuditRow {
  id: number;
  ts: string;
  actor: AuditActor;
  event: string;
  dispute_id: string | null;
  payload_json: string;
  prev_hash: string;
  hash: string;
}

export interface AuditInput {
  actor: AuditActor;
  event: string;
  disputeId: string | null;
  payload: unknown;
  ts: string;
}

const GENESIS = "0".repeat(64);

function rowHash(
  prev: string,
  r: Pick<AuditRow, "ts" | "actor" | "event" | "dispute_id" | "payload_json">,
) {
  return sha256(
    canonicalJson({
      prev,
      ts: r.ts,
      actor: r.actor,
      event: r.event,
      dispute_id: r.dispute_id,
      payload: JSON.parse(r.payload_json),
    }),
  );
}

export function appendAudit(db: Db, input: AuditInput): AuditRow {
  const append = db.transaction((): AuditRow => {
    const last = db.prepare("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get() as
      | { hash: string }
      | undefined;
    const prev_hash = last?.hash ?? GENESIS;
    const payload_json = canonicalJson(input.payload);
    const partial = {
      ts: input.ts,
      actor: input.actor,
      event: input.event,
      dispute_id: input.disputeId,
      payload_json,
    };
    const hash = rowHash(prev_hash, partial);
    const info = db
      .prepare(
        "INSERT INTO audit (ts, actor, event, dispute_id, payload_json, prev_hash, hash) VALUES (@ts, @actor, @event, @dispute_id, @payload_json, @prev_hash, @hash)",
      )
      .run({ ...partial, prev_hash, hash });
    return { id: Number(info.lastInsertRowid), ...partial, prev_hash, hash };
  });
  return append();
}

export function listAudit(db: Db, disputeId?: string): AuditRow[] {
  if (disputeId) {
    return db
      .prepare("SELECT * FROM audit WHERE dispute_id = ? ORDER BY id")
      .all(disputeId) as AuditRow[];
  }
  return db.prepare("SELECT * FROM audit ORDER BY id").all() as AuditRow[];
}

export interface ChainResult {
  ok: boolean;
  length: number;
  brokenAt?: number;
}

export function verifyChain(db: Db): ChainResult {
  const rows = listAudit(db);
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev || rowHash(prev, row) !== row.hash) {
      return { ok: false, length: rows.length, brokenAt: row.id };
    }
    prev = row.hash;
  }
  return { ok: true, length: rows.length };
}

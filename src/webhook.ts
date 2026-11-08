import { z } from "zod";
import { appendAudit } from "./audit.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { ReadOnlyPayPalClient } from "./paypal/client.js";
import { syncOne } from "./sync.js";

export type SignatureVerifier = (
  headers: Record<string, string | undefined>,
  event: unknown,
) => Promise<boolean>;

export interface WebhookDeps {
  db: Db;
  reader: ReadOnlyPayPalClient;
  clock: Clock;
  verify: SignatureVerifier;
}

const WebhookEvent = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.object({ dispute_id: z.string().optional() }).passthrough().optional(),
});

export type WebhookOutcome =
  | { status: "accepted"; processing: Promise<void> }
  | { status: "duplicate" }
  | { status: "rejected"; reason: string };

export async function handleWebhook(
  deps: WebhookDeps,
  input: { headers: Record<string, string | undefined>; event: unknown },
): Promise<WebhookOutcome> {
  const { db, clock } = deps;
  const ts = () => clock.now().toISOString();

  if (!(await deps.verify(input.headers, input.event))) {
    appendAudit(db, {
      actor: "paypal",
      event: "webhook_rejected",
      disputeId: null,
      payload: { reason: "signature verification failed" },
      ts: ts(),
    });
    return { status: "rejected", reason: "signature verification failed" };
  }
  const parsed = WebhookEvent.safeParse(input.event);
  if (!parsed.success) {
    appendAudit(db, {
      actor: "paypal",
      event: "webhook_rejected",
      disputeId: null,
      payload: { reason: "malformed event" },
      ts: ts(),
    });
    return { status: "rejected", reason: "malformed event" };
  }
  const event = parsed.data;
  const disputeId = event.resource?.dispute_id ?? null;

  const inserted = db
    .prepare(
      "INSERT OR IGNORE INTO webhook_events (event_id, type, received_at, status) VALUES (?, ?, ?, 'received')",
    )
    .run(event.id, event.event_type, ts());
  if (inserted.changes === 0) {
    appendAudit(db, {
      actor: "system",
      event: "webhook_duplicate_ignored",
      disputeId,
      payload: { event_id: event.id },
      ts: ts(),
    });
    return { status: "duplicate" };
  }
  appendAudit(db, {
    actor: "paypal",
    event: "webhook_received",
    disputeId,
    payload: { event_id: event.id, type: event.event_type },
    ts: ts(),
  });

  const processing = (async () => {
    try {
      if (disputeId) await syncOne(deps, disputeId);
      db.prepare(
        "UPDATE webhook_events SET status = 'processed', processed_at = ? WHERE event_id = ?",
      ).run(ts(), event.id);
    } catch (err) {
      db.prepare(
        "UPDATE webhook_events SET status = 'failed', processed_at = ? WHERE event_id = ?",
      ).run(ts(), event.id);
      appendAudit(db, {
        actor: "system",
        event: "webhook_failed",
        disputeId,
        payload: { event_id: event.id, error: String(err) },
        ts: ts(),
      });
    }
  })();
  return { status: "accepted", processing };
}

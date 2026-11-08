import { appendAudit } from "./audit.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { ReadOnlyPayPalClient } from "./paypal/client.js";

export interface SyncDeps {
  db: Db;
  reader: ReadOnlyPayPalClient;
  clock: Clock;
}

export async function syncDisputes({ db, reader, clock }: SyncDeps): Promise<number> {
  const disputes = await reader.listDisputes();
  const upsert = db.prepare(`
    INSERT INTO disputes (paypal_id, status, reason, amount, currency, raw_json, due_at, created_at, updated_at)
    VALUES (@paypal_id, @status, @reason, @amount, @currency, @raw_json, @due_at, @created_at, @updated_at)
    ON CONFLICT(paypal_id) DO UPDATE SET
      status = excluded.status, reason = excluded.reason, amount = excluded.amount,
      currency = excluded.currency, raw_json = excluded.raw_json, due_at = excluded.due_at,
      updated_at = excluded.updated_at`);
  db.transaction(() => {
    for (const d of disputes) {
      upsert.run({
        paypal_id: d.dispute_id,
        status: d.status,
        reason: d.reason,
        amount: d.dispute_amount.value,
        currency: d.dispute_amount.currency_code,
        raw_json: JSON.stringify(d),
        due_at: d.seller_response_due_date,
        created_at: d.create_time,
        updated_at: d.update_time,
      });
    }
  })();
  appendAudit(db, {
    actor: "system",
    event: "sync",
    disputeId: null,
    payload: { disputes: disputes.length },
    ts: clock.now().toISOString(),
  });
  return disputes.length;
}

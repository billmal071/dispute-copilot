import { describe, expect, it } from "vitest";
import { listAudit, verifyChain } from "../src/audit.js";
import type { ReadOnlyPayPalClient } from "../src/paypal/client.js";
import { handleWebhook } from "../src/webhook.js";
import { makeApp } from "./app-helpers.js";

const event = (id: string, disputeId = "PP-D-1001") => ({
  id,
  event_type: "CUSTOMER.DISPUTE.UPDATED",
  resource: { dispute_id: disputeId },
});
const accept = async () => true;

async function setup() {
  const app = await makeApp();
  let fetches = 0;
  const reader: ReadOnlyPayPalClient = {
    ...app.reader,
    getDispute: (id) => {
      fetches += 1;
      return app.reader.getDispute(id);
    },
  };
  return { app, reader, fetches: () => fetches };
}

describe("webhook intake", () => {
  it("records the event, refreshes the dispute and marks it processed", async () => {
    const { app, reader } = await setup();
    await app.mock.acceptClaim(
      "PP-D-1001",
      { note: "n", accept_claim_reason: "NOT_ABLE_TO_WIN" },
      "k",
    );
    const out = await handleWebhook(
      { db: app.db, reader, clock: app.clock, verify: accept },
      { headers: {}, event: event("WH-1") },
    );
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") await out.processing;
    const stored = app.db
      .prepare("SELECT status, processed_at FROM webhook_events WHERE event_id = 'WH-1'")
      .get() as { status: string; processed_at: string | null };
    expect(stored.status).toBe("processed");
    expect(stored.processed_at).not.toBeNull();
    const dispute = app.db
      .prepare("SELECT status FROM disputes WHERE paypal_id = 'PP-D-1001'")
      .get() as { status: string };
    expect(dispute.status).toBe("RESOLVED");
  });

  it("ignores a replayed event id and leaves state unchanged", async () => {
    const { app, reader, fetches } = await setup();
    const deps = { db: app.db, reader, clock: app.clock, verify: accept };
    const first = await handleWebhook(deps, { headers: {}, event: event("WH-2") });
    if (first.status === "accepted") await first.processing;
    const before = app.db.prepare("SELECT * FROM disputes ORDER BY id").all();
    const second = await handleWebhook(deps, { headers: {}, event: event("WH-2") });
    expect(second.status).toBe("duplicate");
    expect(fetches()).toBe(1);
    expect(app.db.prepare("SELECT * FROM disputes ORDER BY id").all()).toEqual(before);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toEqual({ n: 1 });
    const events = listAudit(app.db).map((r) => r.event);
    expect(events.filter((e) => e === "webhook_received")).toHaveLength(1);
    expect(events.filter((e) => e === "webhook_duplicate_ignored")).toHaveLength(1);
    expect(verifyChain(app.db).ok).toBe(true);
  });

  it("rejects an event whose signature fails verification and stores nothing", async () => {
    const { app, reader } = await setup();
    const out = await handleWebhook(
      { db: app.db, reader, clock: app.clock, verify: async () => false },
      { headers: {}, event: event("WH-3") },
    );
    expect(out.status).toBe("rejected");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toEqual({ n: 0 });
    expect(listAudit(app.db).map((r) => r.event)).toContain("webhook_rejected");
  });

  it("rejects a payload without an event id", async () => {
    const { app, reader } = await setup();
    const out = await handleWebhook(
      { db: app.db, reader, clock: app.clock, verify: accept },
      { headers: {}, event: { event_type: "X" } },
    );
    expect(out.status).toBe("rejected");
  });

  it("marks the event failed when the refresh fails, without throwing at the caller", async () => {
    const { app } = await setup();
    const reader: ReadOnlyPayPalClient = {
      ...app.reader,
      getDispute: async () => {
        throw new Error("boom");
      },
    };
    const out = await handleWebhook(
      { db: app.db, reader, clock: app.clock, verify: accept },
      { headers: {}, event: event("WH-4") },
    );
    if (out.status === "accepted") await out.processing;
    const stored = app.db
      .prepare("SELECT status FROM webhook_events WHERE event_id = 'WH-4'")
      .get() as { status: string };
    expect(stored.status).toBe("failed");
  });
});

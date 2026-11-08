import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { PayPalError, readOnly } from "../src/paypal/client.js";
import { MockPayPal, seedMock } from "../src/paypal/mock.js";
import { SCENARIOS } from "../src/seed/scenarios.js";

let db: Db;
let mock: MockPayPal;
const ID = "PP-D-1001";
const evidence = {
  evidences: [
    {
      evidence_type: "PROOF_OF_FULFILLMENT" as const,
      notes: "Shipped via DHL, delivered and signed.",
    },
  ],
};

beforeEach(() => {
  db = openDb(":memory:");
  seedMock(db, SCENARIOS);
  mock = new MockPayPal(db, SCENARIOS);
});

describe("MockPayPal reads", () => {
  it("seeds thirteen disputes all waiting on the seller", async () => {
    const list = await mock.listDisputes();
    expect(list).toHaveLength(13);
    expect(list.every((d) => d.status === "WAITING_FOR_SELLER_RESPONSE")).toBe(true);
  });

  it("filters by status", async () => {
    expect(await mock.listDisputes({ status: "RESOLVED" })).toEqual([]);
  });

  it("exposes a provide-evidence link while waiting on the seller", async () => {
    const d = await mock.getDispute(ID);
    expect(d.links.map((l) => l.rel)).toContain("provide-evidence");
  });

  it("404s on an unknown dispute like PayPal does", async () => {
    await expect(mock.getDispute("NOPE")).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("returns transaction, order and tracking by id", async () => {
    const d = await mock.getDispute(ID);
    const txnId = d.disputed_transactions[0]?.seller_transaction_id ?? "";
    expect((await mock.getTransaction(txnId)).id).toBe(txnId);
    expect((await mock.getTracking(txnId))?.status).toBe("DELIVERED");
    const txn = await mock.getTransaction(txnId);
    expect((await mock.getOrder(txn.order_id)).items.length).toBeGreaterThan(0);
  });

  it("returns null tracking when none exists", async () => {
    const d = await mock.getDispute("PP-D-1013");
    const txnId = d.disputed_transactions[0]?.seller_transaction_id ?? "";
    expect(await mock.getTracking(txnId)).toBeNull();
  });

  it("read-only wrapper hides write methods at runtime", () => {
    const ro = readOnly(mock) as unknown as Record<string, unknown>;
    expect(ro.provideEvidence).toBeUndefined();
    expect(ro.acceptClaim).toBeUndefined();
    expect(ro.makeOffer).toBeUndefined();
  });
});

describe("MockPayPal writes", () => {
  it("provide-evidence moves the dispute to UNDER_REVIEW", async () => {
    await mock.provideEvidence(ID, evidence, "req-1");
    expect((await mock.getDispute(ID)).status).toBe("UNDER_REVIEW");
  });

  it("rejects evidence notes over 2000 characters", async () => {
    const big = { evidences: [{ evidence_type: "OTHER" as const, notes: "x".repeat(2001) }] };
    await expect(mock.provideEvidence(ID, big, "req-2")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an empty evidence list", async () => {
    await expect(mock.provideEvidence(ID, { evidences: [] }, "req-3")).rejects.toBeInstanceOf(
      PayPalError,
    );
  });

  it("refuses evidence once the dispute is no longer waiting on the seller", async () => {
    await mock.provideEvidence(ID, evidence, "req-4");
    await expect(mock.provideEvidence(ID, evidence, "req-5")).rejects.toMatchObject({
      status: 422,
    });
  });

  it("replays the stored response for a repeated PayPal-Request-Id and applies it once", async () => {
    const first = await mock.provideEvidence(ID, evidence, "same-key");
    const second = await mock.provideEvidence(ID, evidence, "same-key");
    expect(second).toEqual(first);
    expect(mock.writeCount).toBe(1);
  });

  it("accept-claim resolves in the buyer's favour", async () => {
    await mock.acceptClaim(
      ID,
      { note: "Refunding.", accept_claim_reason: "NOT_ABLE_TO_WIN" },
      "req-6",
    );
    const d = await mock.getDispute(ID);
    expect(d.status).toBe("RESOLVED");
    expect(d.dispute_outcome?.outcome_code).toBe("RESOLVED_BUYER_FAVOR");
  });

  it("make-offer waits on the buyer and rejects an offer above the disputed amount", async () => {
    await expect(
      mock.makeOffer(
        "PP-D-1008",
        {
          note: "n",
          offer_amount: { currency_code: "USD", value: "500.00" },
          offer_type: "REFUND",
        },
        "req-7",
      ),
    ).rejects.toMatchObject({ status: 422 });
    await mock.makeOffer(
      "PP-D-1008",
      { note: "n", offer_amount: { currency_code: "USD", value: "12.00" }, offer_type: "REFUND" },
      "req-8",
    );
    expect((await mock.getDispute("PP-D-1008")).status).toBe("WAITING_FOR_BUYER_RESPONSE");
  });

  it("persists state across instances sharing the database", async () => {
    await mock.provideEvidence(ID, evidence, "req-9");
    const again = new MockPayPal(db, SCENARIOS);
    expect((await again.getDispute(ID)).status).toBe("UNDER_REVIEW");
  });

  it("sandbox helpers drive the lifecycle", async () => {
    await mock.provideEvidence(ID, evidence, "req-10");
    await mock.sandboxAdjudicate(ID, "SELLER_FAVOR");
    expect((await mock.getDispute(ID)).dispute_outcome?.outcome_code).toBe("RESOLVED_SELLER_FAVOR");
    await expect(mock.sandboxAdjudicate(ID, "SELLER_FAVOR")).rejects.toMatchObject({ status: 422 });
  });
});

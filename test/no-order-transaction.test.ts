import { describe, expect, it } from "vitest";
import { executeReadTool } from "../src/agent/tools.js";
import { openDb } from "../src/db.js";
import { createMerchantData } from "../src/merchant/data.js";
import { withDisputeBuyer } from "../src/paypal/mappers.js";
import { SandboxPayPal } from "../src/paypal/real.js";
import { SCENARIOS } from "../src/seed/scenarios.js";
import { detailPage } from "../src/web/views.js";
import { dispute, NOW, txn } from "./helpers.js";

const capture = {
  id: "7ML06735TW501954Y",
  status: "PENDING",
  amount: { currency_code: "USD", value: "10.00" },
  create_time: "2026-11-01T00:00:00Z",
};

function sandbox(onCall: (url: string) => void) {
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    onCall(u);
    if (u.endsWith("/v1/oauth2/token"))
      return Response.json({ access_token: "t", expires_in: 3600 });
    return Response.json(capture);
  }) as typeof fetch;
  return new SandboxPayPal({ clientId: "c", clientSecret: "s", fetchImpl });
}

describe("transaction without a linked order", () => {
  it("does not call the orders endpoint and maps blanks", async () => {
    const urls: string[] = [];
    const t = await sandbox((u) => urls.push(u)).getTransaction(capture.id);
    expect(urls.some((u) => u.includes("/v2/checkout/orders"))).toBe(false);
    expect(t.order_id).toBe("");
    expect(t.shipping_address).toBeNull();
    expect(t.refunds).toEqual([]);
  });

  it("falls back to the dispute buyer when the transaction has none", () => {
    const blank = txn({ order_id: "", buyer: { id: "", name: "", email: "" } });
    const filled = withDisputeBuyer(blank, dispute());
    expect(filled.buyer).toEqual({ id: "B1", name: "Ada", email: "" });
  });

  it("keeps the transaction buyer fields that exist", () => {
    const filled = withDisputeBuyer(txn(), dispute());
    expect(filled.buyer).toEqual({ id: "B1", name: "Ada", email: "ada@example.com" });
  });

  it("the agent get_transaction tool applies the dispute buyer fallback", async () => {
    const blank = txn({ buyer: { id: "", name: "", email: "" } });
    const reader = {
      listDisputes: async () => [],
      getDispute: async () => dispute(),
      getTransaction: async () => blank,
      getOrder: async () => {
        throw new Error("must not be called");
      },
      getTracking: async () => null,
    };
    const run = await executeReadTool(
      "get_transaction",
      { transaction_id: "TXN-1" },
      reader,
      createMerchantData(openDb(":memory:"), SCENARIOS),
      "PP-D-1",
    );
    const out = run.output as { buyer: { id: string; name: string } };
    expect(out.buyer.id).toBe("B1");
    expect(out.buyer.name).toContain("Ada");
  });

  it("renders order, shipping and tracking as not available", () => {
    const html = String(
      detailPage(
        {
          dispute: dispute(),
          transaction: txn({
            order_id: "",
            shipping_address: null,
            buyer: { id: "B1", name: "", email: "" },
          }),
          order: null,
          tracking: null,
        },
        "" as never,
        NOW,
      ),
    );
    expect(html).toMatch(/Order<\/dt><dd[^>]*>Not available/);
    expect(html).toMatch(/Ship to<\/dt><dd>(<mark[^>]*>)?Not available/);
    expect(html).toMatch(/Buyer<\/dt><dd>Not available/);
  });
});

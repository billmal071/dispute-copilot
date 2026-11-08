import { describe, expect, it } from "vitest";
import { PayPalError } from "../src/paypal/client.js";
import { SandboxPayPal } from "../src/paypal/real.js";

type Call = { url: string; init: RequestInit };

function harness(responses: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    if (call.url.endsWith("/v1/oauth2/token")) {
      return Response.json({ access_token: `tok-${calls.length}`, expires_in: 3600, scope: "a b" });
    }
    return responses(call, calls.length);
  }) as typeof fetch;
  const client = new SandboxPayPal({
    clientId: "cid",
    clientSecret: "super-secret",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

const rawDispute = {
  dispute_id: "PP-D-9",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "10.00" },
  create_time: "2026-11-01T00:00:00Z",
  update_time: "2026-11-02T00:00:00Z",
  seller_response_due_date: "2026-11-12T00:00:00Z",
  disputed_transactions: [{ seller_transaction_id: "T1", buyer: { name: "Ada", payer_id: "B1" } }],
  messages: [],
  links: [],
};

describe("SandboxPayPal", () => {
  it("requests a token with basic auth and caches it across calls", async () => {
    const { client, calls } = harness(() => Response.json(rawDispute));
    await client.getDispute("PP-D-9");
    await client.getDispute("PP-D-9");
    const tokenCalls = calls.filter((c) => c.url.endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    const headers = new Headers(tokenCalls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("cid:super-secret").toString("base64")}`,
    );
    expect(String(tokenCalls[0]?.init.body)).toContain("grant_type=client_credentials");
  });

  it("maps a dispute detail response", async () => {
    const { client } = harness(() => Response.json(rawDispute));
    const d = await client.getDispute("PP-D-9");
    expect(d.disputed_transactions[0]?.buyer.id).toBe("B1");
    expect(d.dispute_amount.value).toBe("10.00");
  });

  it("sends the approval idempotency key as PayPal-Request-Id on writes", async () => {
    const { client, calls } = harness(() => Response.json({ links: [] }));
    await client.acceptClaim(
      "PP-D-9",
      { note: "ok", accept_claim_reason: "NOT_ABLE_TO_WIN" },
      "key-123",
    );
    const write = calls.find((c) => c.url.endsWith("/accept-claim"));
    expect(new Headers(write?.init.headers).get("paypal-request-id")).toBe("key-123");
    expect(write?.init.method).toBe("POST");
  });

  it("posts evidence as multipart with a JSON input part", async () => {
    const { client, calls } = harness(() => Response.json({ links: [] }));
    await client.provideEvidence(
      "PP-D-9",
      {
        evidences: [
          {
            evidence_type: "PROOF_OF_FULFILLMENT",
            notes: "n",
            evidence_info: { tracking_info: [{ carrier_name: "DHL", tracking_number: "X1" }] },
          },
        ],
        files: [
          { name: "proof.pdf", contentType: "application/pdf", data: new Uint8Array([1, 2]) },
        ],
      },
      "k",
    );
    const write = calls.find((c) => c.url.endsWith("/provide-evidence"));
    const body = write?.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const input = body.get("input") as Blob;
    expect(JSON.parse(await input.text()).evidences[0].evidence_type).toBe("PROOF_OF_FULFILLMENT");
    expect(body.get("evidence-file")).toBeInstanceOf(Blob);
  });

  it("retries 503 with exponential backoff and then succeeds", async () => {
    let attempts = 0;
    const { client, sleeps } = harness(() => {
      attempts += 1;
      return attempts < 3 ? new Response("down", { status: 503 }) : Response.json(rawDispute);
    });
    await client.getDispute("PP-D-9");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("gives up after the retry budget with a PayPal-unavailable error", async () => {
    const { client } = harness(() => new Response("down", { status: 503 }));
    await expect(client.getDispute("PP-D-9")).rejects.toMatchObject({
      status: 503,
      code: "PAYPAL_UNAVAILABLE",
    });
  });

  it("does not retry client errors", async () => {
    let attempts = 0;
    const { client } = harness(() => {
      attempts += 1;
      return Response.json({ name: "RESOURCE_NOT_FOUND", message: "nope" }, { status: 404 });
    });
    await expect(client.getDispute("X")).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
    });
    expect(attempts).toBe(1);
  });

  it("names the missing scope on a 403", async () => {
    const { client } = harness(() =>
      Response.json({ name: "NOT_AUTHORIZED", message: "x" }, { status: 403 }),
    );
    const err = await client.getDispute("X").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).message).toContain(
      "https://uri.paypal.com/services/disputes/read-seller",
    );
  });

  it("names the update scope when a write is forbidden", async () => {
    const { client } = harness(() => Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }));
    const err = await client
      .acceptClaim("X", { note: "n", accept_claim_reason: "NOT_ABLE_TO_WIN" }, "k")
      .catch((e: unknown) => e);
    expect((err as PayPalError).message).toContain("disputes/update-seller");
  });

  it("refreshes the token once on 401", async () => {
    let first = true;
    const { client, calls } = harness(() => {
      if (first) {
        first = false;
        return new Response("", { status: 401 });
      }
      return Response.json(rawDispute);
    });
    await client.getDispute("PP-D-9");
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("reports token failure without leaking the secret", async () => {
    const client = new SandboxPayPal({
      clientId: "cid",
      clientSecret: "super-secret",
      fetchImpl: (async () =>
        new Response('{"error":"invalid_client"}', { status: 401 })) as typeof fetch,
      sleep: async () => {},
    });
    const err = await client.getDispute("X").catch((e: unknown) => e);
    expect((err as PayPalError).code).toBe("TOKEN_FAILURE");
    expect((err as PayPalError).message).not.toContain("super-secret");
  });

  it("returns null tracking on 404", async () => {
    const { client } = harness(() =>
      Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 }),
    );
    expect(await client.getTracking("T1")).toBeNull();
  });
});

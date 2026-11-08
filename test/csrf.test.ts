import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/app.js";
import { createServer } from "../src/server.js";
import { makeApp } from "./app-helpers.js";
import { startSession } from "./csrf-helpers.js";

async function setup() {
  const app = await makeApp();
  const ctx: AppContext = { mode: "mock", ...app, verify: async () => true };
  const server = createServer(ctx);
  const session = await startSession(server);
  const post = (path: string, data: Record<string, string> = {}, headers: HeadersInit = {}) =>
    server.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(data).toString(),
    });
  const authed = (extra: HeadersInit = {}) => ({
    cookie: session.cookie,
    "x-csrf-token": session.token,
    ...extra,
  });
  return { app, server, session, post, authed };
}

describe("CSRF protection on state-changing requests", () => {
  it("rejects the cross-origin approve with no token and sends nothing", async () => {
    const { app, post } = await setup();
    const res = await post(
      "/drafts/1/approve",
      { idempotency_key: "evil" },
      { origin: "http://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(app.calls).toHaveLength(0);
  });

  it("rejects a POST with no token even without an Origin header", async () => {
    const { app, post } = await setup();
    expect((await post("/drafts/1/approve", { idempotency_key: "k" })).status).toBe(403);
    expect((await post("/drafts/1/submit")).status).toBe(403);
    expect((await post("/sync")).status).toBe(403);
    expect(app.calls).toHaveLength(0);
  });

  it("rejects a valid token delivered from a cross-origin page", async () => {
    const { post, authed } = await setup();
    const res = await post("/sync", {}, authed({ origin: "http://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("rejects Sec-Fetch-Site: cross-site even with a valid token", async () => {
    const { post, authed } = await setup();
    const res = await post("/sync", {}, authed({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  it("rejects a token that does not match the cookie", async () => {
    const { post, session } = await setup();
    const res = await post("/sync", {}, { cookie: session.cookie, "x-csrf-token": "forged" });
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin POST carrying the header token or the form field", async () => {
    const { post, authed, session } = await setup();
    const viaHeader = await post("/sync", {}, authed({ origin: "http://localhost" }));
    expect(viaHeader.status).toBe(303);
    const viaField = await post(
      "/sync",
      { csrf_token: session.token },
      { cookie: session.cookie, origin: "http://localhost" },
    );
    expect(viaField.status).toBe(303);
  });

  it("leaves the signature-gated webhook endpoint outside CSRF", async () => {
    const { server } = await setup();
    const res = await server.request("/webhooks/paypal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "WH-1", event_type: "CUSTOMER.DISPUTE.UPDATED", resource: {} }),
    });
    expect(res.status).toBe(200);
  });
});

describe("approval is bound to the previewed draft", () => {
  async function drafted() {
    const s = await setup();
    const draft = () => s.post("/disputes/PP-D-1001/draft", {}, s.authed({ "hx-request": "true" }));
    await draft();
    return { ...s, draft };
  }

  it("refuses an approval that does not carry the draft version", async () => {
    const { app, post, authed } = await drafted();
    const res = await post("/drafts/1/approve", { idempotency_key: "k1" }, authed());
    expect(res.status).toBe(409);
    expect(app.calls).toHaveLength(0);
  });

  it("refuses to approve a draft that a newer draft superseded", async () => {
    const { app, post, authed, draft } = await drafted();
    await draft();
    const res = await post(
      "/drafts/1/approve",
      { idempotency_key: "k1", draft_id: "1", draft_version: "1" },
      authed(),
    );
    expect(res.status).toBe(409);
    expect(app.calls).toHaveLength(0);
  });

  it("refuses a second approval for the same dispute, even on a newer draft", async () => {
    const { app, post, authed } = await drafted();
    const first = await post(
      "/drafts/1/approve",
      { idempotency_key: "k1", draft_id: "1", draft_version: "1" },
      authed({ "hx-request": "true" }),
    );
    expect(first.status).toBe(200);
    app.db.exec(
      `INSERT INTO drafts (dispute_id, version, json, score, score_json, trace_json, model, source, state, created_at)
       SELECT dispute_id, 2, json, score, score_json, trace_json, model, source, state, created_at FROM drafts WHERE id = 1`,
    );
    const second = await post(
      "/drafts/2/approve",
      { idempotency_key: "k2", draft_id: "2", draft_version: "2" },
      authed(),
    );
    expect(second.status).toBe(409);
    expect(app.mock.writeCount).toBe(1);
  });
});

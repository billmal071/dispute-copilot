import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayLLM, ResponseCache } from "../src/agent/llm.js";
import type { AppContext } from "../src/app.js";
import { createServer } from "../src/server.js";
import { makeApp } from "./app-helpers.js";
import { startSession, withSession } from "./csrf-helpers.js";

async function setup(over: Partial<AppContext> = {}) {
  const app = await makeApp();
  const ctx: AppContext = { mode: "mock", ...app, verify: async () => true, ...over };
  const raw = createServer(ctx);
  return { app, ctx, server: withSession(raw, await startSession(raw)) };
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
  body: new URLSearchParams(data).toString(),
});

async function draftFor(server: ReturnType<typeof createServer>, id = "PP-D-1001") {
  const res = await server.request(`/disputes/${id}/draft`, form({}));
  return { res, html: await res.text() };
}

describe("inbox", () => {
  it("lists all seeded disputes with status chips and a MOCK banner", async () => {
    const { server } = await setup();
    const res = await server.request("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html.match(/data-dispute-row/g)).toHaveLength(13);
    expect(html).toContain("Waiting for you");
    expect(html).toContain("MOCK");
    expect(html).toContain("/assets/htmx.js");
  });

  it("shows an empty state instead of a blank page when nothing is synced", async () => {
    const { server, app } = await setup();
    app.db.prepare("DELETE FROM disputes").run();
    const html = await (await server.request("/")).text();
    expect(html).toContain("No disputes yet");
  });
});

describe("dispute detail", () => {
  it("renders the dispute, transaction and tracking evidence with a draft call to action", async () => {
    const { server } = await setup();
    const res = await server.request("/disputes/PP-D-1001");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("5TX10010042");
    expect(html).toContain("JD0146100177");
    expect(html).toContain("Draft with agent");
  });

  it("escapes buyer-controlled text", async () => {
    const { server, app } = await setup();
    const row = app.db.prepare("SELECT json FROM mock_disputes WHERE id = 'PP-D-1001'").get() as {
      json: string;
    };
    const rec = JSON.parse(row.json);
    rec.dispute.messages[0].content = "<script>alert(1)</script>";
    app.db
      .prepare("UPDATE mock_disputes SET json = ? WHERE id = 'PP-D-1001'")
      .run(JSON.stringify(rec));
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("404s with a real page for an unknown dispute", async () => {
    const { server } = await setup();
    const res = await server.request("/disputes/NOPE");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Dispute not found");
  });
});

describe("drafting", () => {
  it("shows recommendation, score breakdown, replay label and tool trace", async () => {
    const { server } = await setup();
    const { res, html } = await draftFor(server);
    expect(res.status).toBe(200);
    expect(html).toContain("CONTEST");
    expect(html).toContain("Replayed");
    expect(html).toContain("get_tracking");
    expect(html).toContain("Required evidence present");
    expect(html).toContain('data-score="100"');
  });

  it("explains a missing recording and offers a retry", async () => {
    const empty = new ReplayLLM(new ResponseCache(mkdtempSync(join(tmpdir(), "empty-"))));
    const { server } = await setup({ llm: empty });
    const { html } = await draftFor(server);
    expect(html).toContain("No recorded model response");
    expect(html).toContain("Retry");
  });
});

describe("approval flow", () => {
  it("previews the exact outbound payload before anything is sent", async () => {
    const { server, app } = await setup();
    await draftFor(server);
    const res = await server.request(
      "/drafts/1/preview",
      form({ note_0: "Edited note for order LL-1001 on 2026-10-26." }),
    );
    const html = await res.text();
    expect(html).toContain("provide-evidence");
    expect(html).toContain("PayPal-Request-Id");
    expect(html).toContain("Edited note for order LL-1001");
    expect(app.calls).toHaveLength(0);
  });

  it("approve submits once even when the button is double-clicked", async () => {
    const { server, app } = await setup();
    await draftFor(server);
    const body = form({ idempotency_key: "click-1", draft_id: "1", draft_version: "1" });
    const a = await server.request("/drafts/1/approve", body);
    const b = await server.request("/drafts/1/approve", body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.text()).toContain("Under review");
    expect(app.mock.writeCount).toBe(1);
  });

  it("returns 403 and audits when submit is called without approval", async () => {
    const { server, app } = await setup();
    await draftFor(server);
    const res = await server.request("/drafts/1/submit", form({}));
    expect(res.status).toBe(403);
    expect(app.calls).toHaveLength(0);
    const audit = await (await server.request("/audit?dispute=PP-D-1001")).text();
    expect(audit).toContain("submit_blocked");
  });

  it("reject leaves PayPal untouched and shows the decision", async () => {
    const { server, app } = await setup();
    await draftFor(server);
    const res = await server.request("/drafts/1/reject", form({ idempotency_key: "r1" }));
    expect(await res.text()).toContain("Rejected");
    expect(app.calls).toHaveLength(0);
    const detail = await (await server.request("/disputes/PP-D-1001")).text();
    expect(detail).toContain("Rejected");
  });
});

describe("audit and webhooks", () => {
  it("verifies the hash chain and exports JSON", async () => {
    const { server } = await setup();
    await draftFor(server);
    const verify = await (await server.request("/audit/verify")).json();
    expect(verify).toMatchObject({ ok: true });
    const exported = await (await server.request("/audit/export.json")).json();
    expect(Array.isArray(exported.entries)).toBe(true);
    expect(exported.verification.ok).toBe(true);
  });

  it("acknowledges webhooks fast and reports a replay as a duplicate", async () => {
    const { server } = await setup();
    const post = () =>
      server.request("/webhooks/paypal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "WH-9",
          event_type: "CUSTOMER.DISPUTE.UPDATED",
          resource: { dispute_id: "PP-D-1001" },
        }),
      });
    const first = await post();
    const second = await post();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(await second.json()).toEqual({ status: "duplicate" });
  });

  it("returns 401 for a webhook that fails verification", async () => {
    const { server } = await setup({ verify: async () => false });
    const res = await server.request("/webhooks/paypal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", event_type: "y" }),
    });
    expect(res.status).toBe(401);
  });
});

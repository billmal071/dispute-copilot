import { describe, expect, it } from "vitest";
import { createDraft } from "../src/agent/draft.js";
import type { AppContext } from "../src/app.js";
import { createServer } from "../src/server.js";
import { makeApp } from "./app-helpers.js";
import { startSession, withSession } from "./csrf-helpers.js";

async function setup() {
  const app = await makeApp();
  const ctx: AppContext = { mode: "mock", ...app, verify: async () => true };
  const raw = createServer(ctx);
  return { app, ctx, server: withSession(raw, await startSession(raw)) };
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
  body: new URLSearchParams(data).toString(),
});

async function drafted(disputeId: string) {
  const s = await setup();
  const made = await createDraft(s.ctx, disputeId);
  if (made.state !== "ok") throw new Error(made.error);
  return { ...s, draft: made.draft };
}

describe("reject is not a dead end", () => {
  it("offers Draft again and says plainly that nothing was sent", async () => {
    const { server, draft } = await drafted("PP-D-1001");
    const res = await server.request(
      `/drafts/${draft.id}/reject`,
      form({ idempotency_key: "rej-1" }),
    );
    const html = await res.text();
    expect(html).toContain("You rejected this draft. Nothing was sent.");
    expect(html).toContain('hx-post="/disputes/PP-D-1001/draft"');
    expect(html).toContain("Draft again");
  });
});

describe("status after approve", () => {
  it("shows the same status in the inbox, the case page and the swapped header card", async () => {
    const { server, draft } = await drafted("PP-D-1001");
    const res = await server.request(
      `/drafts/${draft.id}/approve`,
      form({ idempotency_key: "ok-1", draft_id: String(draft.id), draft_version: "1" }),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/id="fact-status"[^>]*hx-swap-oob="true"/);
    expect(html).toMatch(/hx-swap-oob="true"[\s\S]*Under review/);

    const inbox = await (await server.request("/")).text();
    const row =
      /<li class="case[^"]*"[^>]*data-id="PP-D-1001"[\s\S]*?<\/li>/.exec(inbox)?.[0] ?? "";
    expect(row).toContain("Under review");
    expect(row).not.toContain("Waiting for you");

    const page = await (await server.request("/disputes/PP-D-1001")).text();
    expect(/id="fact-status"[\s\S]*?<\/div>/.exec(page)?.[0]).toContain("Under review");
  });
});

describe("validation error placement", () => {
  it("shows an invalid preview under the review button, not in the modal slot", async () => {
    const { server, draft } = await drafted("PP-D-1001");
    const page = await (await server.request("/disputes/PP-D-1001")).text();
    expect(page.indexOf('id="draft-error"')).toBeGreaterThan(page.indexOf("Review &amp; approve"));
    expect(page.indexOf('id="draft-error"')).toBeLessThan(page.indexOf("Details"));
    const res = await server.request(`/drafts/${draft.id}/preview`, form({ note_0: "" }));
    expect(res.status).toBe(422);
    expect(res.headers.get("hx-retarget")).toBe("#draft-error");
    expect(await res.text()).toContain("Evidence notes must be 1 to 2000 characters.");
  });

  it("asks the page to open the edit section when the message is the problem", async () => {
    const { server, draft } = await drafted("PP-D-1002");
    const res = await server.request(`/drafts/${draft.id}/preview`, form({ merchant_message: "" }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('data-opens="edit-details"');
  });
});

describe("audit and sync feedback", () => {
  it("counts the filtered entries and the full chain separately", async () => {
    const { server, draft } = await drafted("PP-D-1001");
    await server.request(`/drafts/${draft.id}/reject`, form({ idempotency_key: "rej-count" }));
    const html = await (await server.request("/audit?dispute=PP-D-1001")).text();
    expect(html).toMatch(/\d+ entries for PP-D-1001 \(\d+ in the full chain\)/);
    expect(html).not.toContain("across all disputes");
    const all = await (await server.request("/audit")).text();
    expect(all).toMatch(/\d+ entries across all disputes/);
  });

  it("confirms a sync with a flash on the inbox", async () => {
    const { server } = await setup();
    const res = await server.request("/sync", { method: "POST" });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/\?synced=\d+$/);
    const html = await (await server.request(location)).text();
    expect(html).toMatch(/role="status"[^>]*>[\s\S]*Synced \d+ disputes?/);
    expect(await (await server.request("/")).text()).not.toContain("Synced");
  });
});

describe("404 heading", () => {
  it("uses an h1", async () => {
    const { server } = await setup();
    const html = await (await server.request("/nope")).text();
    expect(html).toContain("<h1>Page not found</h1>");
    expect(html).not.toContain("<h2>Page not found</h2>");
  });
});

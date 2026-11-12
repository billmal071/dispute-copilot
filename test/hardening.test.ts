import { describe, expect, it } from "vitest";
import { createDraft } from "../src/agent/draft.js";
import type { AppContext } from "../src/app.js";
import { createServer } from "../src/server.js";
import { makeApp } from "./app-helpers.js";
import { startSession, withSession } from "./csrf-helpers.js";

async function setup(allowedHosts?: string[]) {
  const app = await makeApp();
  const ctx: AppContext = { mode: "mock", ...app, verify: async () => true };
  const raw = createServer(ctx, allowedHosts ? { allowedHosts } : undefined);
  const session = await startSession(raw);
  return { app, ctx, raw, session, server: withSession(raw, session) };
}

const formInit = (data: Record<string, string>, headers: HeadersInit = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(data).toString(),
});

describe("host allow-list (DNS rebinding)", () => {
  it("rejects a request whose Host is not loopback, even with a matching Origin and valid token", async () => {
    const { raw, session } = await setup();
    const res = await raw.request(
      "http://evil.example:3000/sync",
      formInit(
        {},
        {
          origin: "http://evil.example:3000",
          cookie: session.cookie,
          "x-csrf-token": session.token,
        },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("answers /healthz for any Host so a platform health check can reach it", async () => {
    const { raw } = await setup();
    const res = await raw.request("http://10.1.2.3:10000/healthz");
    expect(res.status).toBe(200);
    const other = await raw.request("http://10.1.2.3:10000/");
    expect(other.status).toBe(403);
  });

  it("rejects a GET to a spoofed host", async () => {
    const { raw } = await setup();
    expect((await raw.request("http://rebind.example:3000/")).status).toBe(403);
  });

  it("accepts 127.0.0.1, localhost and [::1]", async () => {
    const { raw } = await setup();
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "localhost"]) {
      expect((await raw.request(`http://${host}/healthz`)).status, host).toBe(200);
    }
  });

  it("accepts a host named in ALLOWED_HOSTS and still rejects others", async () => {
    const { raw } = await setup(["dispute.lan:3000"]);
    expect((await raw.request("http://dispute.lan:3000/")).status).toBe(200);
    expect((await raw.request("http://other.lan:3000/")).status).toBe(403);
  });

  it("leaves the signature-verified webhook reachable through a tunnel host", async () => {
    const { raw } = await setup();
    const res = await raw.request("http://abc.ngrok.example/webhooks/paypal", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).not.toBe(403);
  });
});

describe("security headers", () => {
  it("sets nosniff, frame, referrer and CSP headers on pages", async () => {
    const { raw } = await setup();
    const res = await raw.request("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("script-src");
  });

  it("marks HTML pages no-store but leaves static assets cacheable", async () => {
    const { raw, ctx } = await setup();
    await createDraft(ctx, "PP-D-1001");
    expect((await raw.request("/")).headers.get("cache-control")).toBe("no-store");
    expect((await raw.request("/disputes/PP-D-1001")).headers.get("cache-control")).toBe(
      "no-store",
    );
    expect((await raw.request("/favicon.svg")).headers.get("cache-control")).toContain("max-age");
  });
});

describe("request body limit", () => {
  it("returns 413 for a body over 64 KB", async () => {
    const { server } = await setup();
    const res = await server.request(
      "/drafts/1/preview",
      formInit({ note_0: "x".repeat(70 * 1024) }),
    );
    expect(res.status).toBe(413);
  });
});

describe("preview passthrough", () => {
  it("drops note fields beyond the evidence count", async () => {
    const { server, ctx } = await setup();
    const made = await createDraft(ctx, "PP-D-1001");
    if (made.state !== "ok") throw new Error(made.error);
    const res = await server.request(
      `/drafts/${made.draft.id}/preview`,
      formInit({ note_0: "Edited note for order.", note_9: "injected", note_500: "injected" }),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('name="note_0"');
    expect(html).not.toContain('name="note_9"');
    expect(html).not.toContain('name="note_500"');
  });
});

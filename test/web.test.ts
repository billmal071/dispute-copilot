import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/app.js";
import { prefillDemoDrafts } from "../src/seed/prefill.js";
import { createServer } from "../src/server.js";
import { decisionPanel } from "../src/web/views.js";
import { makeApp } from "./app-helpers.js";
import { startSession, withSession } from "./csrf-helpers.js";

async function setup(prefill = false) {
  const app = await makeApp();
  const ctx: AppContext = { mode: "mock", ...app, verify: async () => true };
  if (prefill) await prefillDemoDrafts(ctx);
  const raw = createServer(ctx);
  return { app, ctx, server: withSession(raw, await startSession(raw)) };
}

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
  body: new URLSearchParams(data).toString(),
});

const attr = (html: string, re: RegExp) => re.exec(html)?.[1] ?? "";

describe("404 page", () => {
  it("renders the app layout with status 404", async () => {
    const { server } = await setup();
    const res = await server.request("/no-such-page");
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('class="topbar"');
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
  });
});

describe("head metadata", () => {
  it("gives every route a unique title, a 50-160 char description, icons, manifest, theme colour and social tags", async () => {
    const { server } = await setup(true);
    const paths = ["/", "/disputes/PP-D-1001", "/audit", "/no-such-page"];
    const titles = new Set<string>();
    for (const path of paths) {
      const html = await (await server.request(path)).text();
      const title = attr(html, /<title>([^<]+)<\/title>/);
      const desc = attr(html, /<meta name="description" content="([^"]*)"/);
      titles.add(title);
      expect(desc.length, path).toBeGreaterThanOrEqual(50);
      expect(desc.length, path).toBeLessThanOrEqual(160);
      expect(html, path).toContain('rel="manifest" href="/manifest.webmanifest"');
      expect(html, path).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
      expect(html, path).toContain('rel="icon" href="/favicon.svg"');
      expect(html, path).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}"/i);
      expect(html, path).toContain('property="og:title"');
      expect(html, path).toContain('property="og:description"');
      expect(html, path).toContain('name="twitter:card"');
    }
    expect(titles.size).toBe(paths.length);
  });

  it("serves the favicon set, manifest and self-hosted fonts and nothing outside them", async () => {
    const { server } = await setup();
    const types: Record<string, string> = {
      "/favicon.svg": "image/svg+xml",
      "/favicon.ico": "image/x-icon",
      "/apple-touch-icon.png": "image/png",
      "/icon-192.png": "image/png",
      "/icon-512.png": "image/png",
      "/manifest.webmanifest": "application/manifest+json",
      "/assets/fonts/geist-latin-wght-normal.woff2": "font/woff2",
      "/assets/fonts/instrument-serif-latin-400-normal.woff2": "font/woff2",
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await server.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
    }
    const manifest = await (await server.request("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "Dispute Copilot", display: "standalone" });
    expect((await server.request("/assets/fonts/..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await server.request("/assets/fonts/nope.woff2")).status).toBe(404);
  });

  it("loads no third-party origins", async () => {
    const { server } = await setup(true);
    const css = await (await server.request("/assets/app.css")).text();
    const html = await (await server.request("/")).text();
    expect(css + html).not.toMatch(/https?:\/\/(?!api-m\.sandbox\.paypal\.com)[a-z0-9.-]+/i);
  });

  it("gives every image alt text", async () => {
    const { server } = await setup(true);
    for (const path of ["/", "/disputes/PP-D-1001", "/audit"]) {
      const html = await (await server.request(path)).text();
      for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img).toMatch(/\balt="/);
    }
  });
});

describe("inbox ordering and summary", () => {
  it("lists disputes by urgency times expected value with a next-case action", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/")).text();
    const ids = [...html.matchAll(/data-dispute-row data-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(13);
    expect(ids[0]).toBe("PP-D-1011");
    const next = attr(html, /class="btn primary next-case" href="([^"]+)"/);
    expect(next).toBe(`/disputes/${ids[0]}`);
    expect(html).toContain("Money at stake");
    expect(html).toContain("Due within 48h");
    expect(html).toContain("Est. recoverable");
  });

  it("shows the agent state, win chance and deadline ring on each row", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/")).text();
    expect(html).toContain("Draft ready");
    expect(html).toContain("Needs a draft");
    expect(html).toMatch(/class="ring [a-z]+"/);
    expect(html).toMatch(/data-win="\d+"/);
  });
});

describe("dispute page", () => {
  it("renders the win chance gauge, breakdown bars and an evidence ledger", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    expect(html).toContain('data-gauge="100"');
    expect(html).toContain('role="meter"');
    expect(html).toContain('data-part="required_evidence"');
    expect(html).toContain('data-part="delivery_verified"');
    expect(html).toContain('data-state="have"');
    expect(html).toContain("Scripted demo fixture");
    expect(html).toContain("not real Claude output");
  });

  it("shows no numeric evidence score when the agent is not contesting", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1002")).text();
    expect(html).toContain("Recommend: Accept this claim");
    expect(html).toContain("Evidence score: n/a, not contesting");
    expect(html).not.toMatch(/data-score="/);
    expect(html).not.toContain("/ 100");
    expect(html).toContain('data-part="grounded_citations"');
    expect(html).toMatch(/Confidence<\/dt><dd>(High|Medium|Low) <span class="tnum">\d+%/);
  });

  it("keeps the evidence score for a contest", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    expect(html).toContain("Evidence score");
    expect(html).toContain("/ 100");
    expect(html).not.toContain("n/a, not contesting");
  });

  it("flags missing evidence and says what to collect", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1013")).text();
    expect(html).toContain('data-state="missing"');
    expect(html).toContain("Carrier and tracking number");
    expect(html).toContain("Merchant input needed");
  });

  it("shows a loading state for the drafting call and keeps the approve action visible", async () => {
    const { server } = await setup();
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    expect(html).toContain('class="drafting"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Draft a response");
  });

  it("puts the exact outbound request in the approval sheet", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    const draftId = attr(html, /hx-post="\/drafts\/(\d+)\/preview"/);
    const sheet = await (await server.request(`/drafts/${draftId}/preview`, form({}))).text();
    expect(sheet).toContain(
      "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1001/provide-evidence",
    );
    expect(sheet).toContain("PayPal-Request-Id");
    expect(sheet).toContain("Authorization");
    expect(sheet).toContain("never leaves this machine");
    expect(sheet).toContain("Approve &amp; send");
    expect(sheet).toContain("Cancel");
  });

  it("shows the sent state with a link to the audit entry after approval", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    const draftId = attr(html, /hx-post="\/drafts\/(\d+)\/preview"/);
    const sheet = await (await server.request(`/drafts/${draftId}/preview`, form({}))).text();
    const key = attr(sheet, /name="idempotency_key" value="([^"]+)"/);
    const version = attr(sheet, /name="draft_version" value="([^"]+)"/);
    const res = await server.request(
      `/drafts/${draftId}/approve`,
      form({ idempotency_key: key, draft_id: draftId, draft_version: version }),
    );
    const out = await res.text();
    expect(out).toContain('class="stamp"');
    expect(out).toContain("Sent to PayPal");
    expect(out).toContain("/audit?dispute=PP-D-1001");
  });
});

describe("redesigned screens", () => {
  it("states each inbox deadline in words and the next step in words, never a code", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/")).text();
    expect(html).toMatch(/Due (in \d+ (hours?|days)|tomorrow)|Overdue/);
    expect(html).toContain("Needs a draft");
    expect(html).not.toMatch(/WAITING_FOR_SELLER_RESPONSE|OFFER_PARTIAL/);
    expect(html).toContain('class="mode mock"');
  });

  it("explains the dispute in plain words with one primary action on the case page", async () => {
    const { server } = await setup();
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    expect(html).toContain('class="claim-plain"');
    expect(html).toMatch(/says (they|the item|it)/);
    expect(html.match(/class="btn primary[^"]*"/g)).toHaveLength(1);
    expect(html).toContain('<details class="casefile"');
  });

  it("leads the draft with the decision, a one-line reason and the approve button", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1002")).text();
    expect(html).toContain("Recommend: Accept this claim");
    expect(html).toContain('class="verdict-why"');
    expect(html).toContain("Review &amp; approve");
    expect(html).toContain("Reject");
    expect(html).toContain("Scripted demo fixture");
    expect(html).toContain('class="mode mock"');
  });

  it("puts the contest decision first and the supporting detail behind labelled sections", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    expect(html).toContain("Recommend: Contest this dispute");
    for (const label of [
      "Evidence ledger",
      "Score breakdown",
      "Why the agent decided this",
      "Edit what gets sent",
      "Tool trace",
    ]) {
      expect(html, label).toMatch(
        new RegExp(`<details class="dt[^"]*"[^>]*><summary[^>]*>[\\s\\S]*?${label}`),
      );
    }
    expect(html.indexOf("Recommend:")).toBeLessThan(html.indexOf("Evidence ledger"));
  });

  it("keeps editable notes inside the approve form so edits are still submitted", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    const form = /<form id="draft-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toContain('name="note_0"');
    const accept = await (await server.request("/disputes/PP-D-1002")).text();
    expect(/<form id="draft-form"[\s\S]*?<\/form>/.exec(accept)?.[0]).toContain(
      'name="merchant_message"',
    );
  });

  it("summarises the send in plain language with an irreversible warning above the exact request", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    const draftId = attr(html, /hx-post="\/drafts\/(\d+)\/preview"/);
    const sheet = await (await server.request(`/drafts/${draftId}/preview`, form({}))).text();
    expect(sheet).toContain('class="send-summary"');
    expect(sheet).toContain("Contest this dispute with");
    expect(sheet).toContain("cannot be undone");
    expect(sheet.indexOf("cannot be undone")).toBeLessThan(sheet.indexOf("provide-evidence"));
    expect(sheet.match(/class="btn primary/g)).toHaveLength(1);
  });
});

describe("sent stamp wording", () => {
  const sentPanel = (mode: "mock" | "sandbox") =>
    decisionPanel(
      { id: 1, dispute_id: "PP-D-1001", version: 1 } as never,
      {
        decision: "approve",
        decidedBy: "merchant",
        decidedAt: "2026-01-01T00:00:00.000Z",
        action: {
          kind: "provide_evidence",
          status: "ok",
          attempts: 1,
          response: {},
          request_id: "r",
        },
      } as never,
      mode,
    ).toString();
  const stamp = (html: string) => /<div class="stamp"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";

  it("says MOCK, never sandbox, in mock mode", () => {
    const s = stamp(sentPanel("mock"));
    expect(s).toMatch(/mock/i);
    expect(s).not.toMatch(/sandbox/i);
  });

  it("says PayPal sandbox, never mock, in sandbox mode", () => {
    const s = stamp(sentPanel("sandbox"));
    expect(s).toMatch(/sandbox/i);
    expect(s).not.toMatch(/mock/i);
  });
});

describe("validation error placement", () => {
  it("sits directly under the approve button, before the hint and the details", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    const at = (needle: string, from = 0) => html.indexOf(needle, from);
    expect(at('id="draft-error"')).toBeGreaterThan(at("Review &amp; approve"));
    expect(at('id="draft-error"')).toBeLessThan(at('class="hint"', at("Review &amp; approve")));
    expect(at('id="draft-error"')).toBeLessThan(at('class="details-stack"'));
  });
});

describe("htmx disabled-elt selectors", () => {
  it("gives the reject button its own target instead of inheriting the form's submit selector", async () => {
    const { server } = await setup(true);
    const html = await (await server.request("/disputes/PP-D-1001")).text();
    const reject = /<button[^>]*hx-post="\/drafts\/\d+\/reject"[^>]*>/.exec(html)?.[0] ?? "";
    expect(reject).toContain('hx-disabled-elt="this"');
  });
});

import { describe, expect, it } from "vitest";
import {
  checklistFor,
  deadlineRing,
  outboundRequest,
  pageMeta,
  rankRows,
  winChance,
} from "../src/web/insight.js";
import type { InboxRow } from "../src/web/views.js";
import type { Dispute } from "../src/types.js";
import { buildPayload } from "../src/actions/approve.js";
import { makeApp } from "./app-helpers.js";
import { latestDraft, createDraft } from "../src/agent/draft.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600000).toISOString();

function row(
  id: string,
  amount: string,
  dueHours: number,
  draft: InboxRow["draft"],
  over: Partial<Dispute> = {},
  decision: string | null = null,
): InboxRow {
  return {
    dispute: {
      dispute_id: id,
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_amount: { currency_code: "USD", value: amount },
      create_time: inHours(-48),
      update_time: inHours(-47),
      seller_response_due_date: inHours(dueHours),
      disputed_transactions: [],
      messages: [],
      links: [],
      ...over,
    },
    draft,
    decision,
  };
}

const contest = (score: number): InboxRow["draft"] => ({
  recommendation: "CONTEST",
  score,
  version: 1,
  offerAmount: null,
});

describe("winChance", () => {
  it("is the evidence score for a contest and null when conceding or settling", () => {
    expect(winChance({ recommendation: "CONTEST", score: 82 })).toBe(0.82);
    expect(winChance({ recommendation: "ACCEPT", score: 90 })).toBeNull();
    expect(winChance({ recommendation: "OFFER_PARTIAL", score: 90 })).toBeNull();
  });
});

describe("rankRows", () => {
  it("sorts by urgency times expected value, not by deadline or amount alone", () => {
    const rows = [
      row("BIG-LATE", "900.00", 160, contest(60)),
      row("SMALL-SOON", "40.00", 6, contest(95)),
      row("MID-SOON", "300.00", 20, contest(90)),
      row("BIG-WEAK-SOON", "500.00", 20, contest(10)),
    ];
    const ids = rankRows(rows, NOW).ranked.map((r) => r.row.dispute.dispute_id);
    expect(ids).toEqual(["MID-SOON", "BIG-LATE", "BIG-WEAK-SOON", "SMALL-SOON"]);
  });

  it("puts decided and non-actionable disputes after actionable ones", () => {
    const rows = [
      row("DONE", "5000.00", 2, contest(100), {}, "approve"),
      row("REVIEW", "5000.00", 2, contest(100), { status: "UNDER_REVIEW" }),
      row("OPEN", "10.00", 150, null),
    ];
    const ids = rankRows(rows, NOW).ranked.map((r) => r.row.dispute.dispute_id);
    expect(ids[0]).toBe("OPEN");
    expect(new Set(ids.slice(1))).toEqual(new Set(["DONE", "REVIEW"]));
  });

  it("totals money at stake, due within 48h and estimated recoverable from scored contests only", () => {
    const rows = [
      row("A", "100.00", 10, contest(80)),
      row("B", "200.00", 100, contest(50)),
      row("C", "50.00", 30, { recommendation: "ACCEPT", score: 70, version: 1, offerAmount: null }),
      row("D", "400.00", 40, null),
    ];
    const { totals } = rankRows(rows, NOW);
    expect(totals.atStake).toBe(750);
    expect(totals.dueSoon).toBe(3);
    expect(totals.recoverable).toBeCloseTo(100 * 0.8 + 200 * 0.5, 5);
    expect(totals.unscored).toBe(1);
  });

  it("counts the part of a partial offer the merchant keeps as recoverable", () => {
    const rows = [
      row("P", "100.00", 50, {
        recommendation: "OFFER_PARTIAL",
        score: 60,
        version: 1,
        offerAmount: 30,
      }),
    ];
    expect(rankRows(rows, NOW).totals.recoverable).toBe(70);
  });
});

describe("deadlineRing", () => {
  it("fills the ring by the share of the 7 day window that is left and flags urgency", () => {
    expect(deadlineRing(inHours(84), NOW)).toMatchObject({ fraction: 0.5, tone: "ok", label: "3d" });
    expect(deadlineRing(inHours(30), NOW)).toMatchObject({ tone: "warn", label: "1d" });
    expect(deadlineRing(inHours(5), NOW)).toMatchObject({ tone: "urgent", label: "5h" });
    expect(deadlineRing(inHours(-1), NOW)).toMatchObject({ fraction: 0, tone: "urgent", label: "Late" });
    expect(deadlineRing(null, NOW)).toMatchObject({ label: "None" });
  });
});

describe("pageMeta", () => {
  it("gives every route a unique title and a 50-160 character description", () => {
    const keys = ["inbox", "dispute", "audit", "notfound", "error"] as const;
    const metas = keys.map((k) => pageMeta(k, { id: "PP-D-1001" }));
    expect(new Set(metas.map((m) => m.title)).size).toBe(keys.length);
    for (const m of metas) {
      expect(m.description.length).toBeGreaterThanOrEqual(50);
      expect(m.description.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("checklist and outbound request on real fixture drafts", () => {
  it("flags missing evidence with what to collect when tracking is absent", async () => {
    const app = await makeApp();
    const ids = (
      app.db.prepare("SELECT paypal_id FROM disputes").all() as { paypal_id: string }[]
    ).map((r) => r.paypal_id);
    const found: Awaited<ReturnType<typeof checklistFor>>[] = [];
    for (const id of ids) {
      await createDraft(app, id);
      const d = latestDraft(app.db, id);
      if (d) found.push(checklistFor(d));
    }
    const missing = found.flat().filter((i) => i.state === "missing");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((i) => i.collect.length > 0)).toBe(true);
    expect(found.flat().some((i) => i.state === "have")).toBe(true);
    const agentFlagged = missing.find((i) => i.source === "agent");
    expect(agentFlagged?.label).toMatch(/tracking|proof/i);
  });

  it("describes the exact request that the real client sends", async () => {
    const app = await makeApp();
    await createDraft(app, "PP-D-1001");
    const stored = latestDraft(app.db, "PP-D-1001");
    if (!stored) throw new Error("no draft");
    const dispute = JSON.parse(
      (app.db.prepare("SELECT raw_json FROM disputes WHERE paypal_id = ?").get("PP-D-1001") as {
        raw_json: string;
      }).raw_json,
    ) as Dispute;
    const payload = buildPayload(dispute, stored.draft);
    const req = outboundRequest(payload, "PP-D-1001", "key-123", "sandbox");
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1001/provide-evidence",
    );
    expect(req.headers).toContainEqual(["PayPal-Request-Id", "key-123"]);
    expect(req.headers.find(([k]) => k === "Authorization")?.[1]).toMatch(/redacted/i);
    expect(req.headers).toContainEqual(["Content-Type", "multipart/form-data"]);
    expect(req.bodyLabel).toMatch(/input/);
    expect(JSON.parse(req.body)).toEqual({ evidences: payload.request.evidences });

    const mock = outboundRequest(payload, "PP-D-1001", "key-123", "mock");
    expect(mock.notSent).toMatch(/mock/i);
  });

  it("sends accept-claim and make-offer as JSON bodies", () => {
    const accept = outboundRequest(
      { kind: "accept-claim", request: { note: "n", accept_claim_reason: "REASON_NOT_SET" } },
      "D1",
      "k",
      "sandbox",
    );
    expect(accept.headers).toContainEqual(["Content-Type", "application/json"]);
    expect(JSON.parse(accept.body)).toEqual({ note: "n", accept_claim_reason: "REASON_NOT_SET" });
  });
});

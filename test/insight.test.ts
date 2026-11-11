import { describe, expect, it } from "vitest";
import { buildPayload } from "../src/actions/approve.js";
import { createDraft, latestDraft } from "../src/agent/draft.js";
import type { Dispute } from "../src/types.js";
import {
  checklistFor,
  confidenceWord,
  deadlineRing,
  decisionHeadline,
  dueWords,
  firstSentence,
  outboundRequest,
  pageMeta,
  plainWords,
  rankRows,
  relevantFacts,
  sendSummary,
  winChance,
} from "../src/web/insight.js";
import type { InboxRow } from "../src/web/views.js";
import { makeApp } from "./app-helpers.js";

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
      row("BIG-WEAK-SOON", "500.00", 20, contest(5)),
    ];
    const ids = rankRows(rows, NOW).ranked.map((r) => r.row.dispute.dispute_id);
    expect(ids).toEqual(["MID-SOON", "BIG-LATE", "SMALL-SOON", "BIG-WEAK-SOON"]);
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
    expect(deadlineRing(inHours(84), NOW)).toMatchObject({
      fraction: 0.5,
      tone: "ok",
      label: "3d",
    });
    expect(deadlineRing(inHours(30), NOW)).toMatchObject({ tone: "warn", label: "1d" });
    expect(deadlineRing(inHours(5), NOW)).toMatchObject({ tone: "urgent", label: "5h" });
    expect(deadlineRing(inHours(-1), NOW)).toMatchObject({
      fraction: 0,
      tone: "urgent",
      label: "Late",
    });
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
      (
        app.db.prepare("SELECT raw_json FROM disputes WHERE paypal_id = ?").get("PP-D-1001") as {
          raw_json: string;
        }
      ).raw_json,
    ) as Dispute;
    const payload = buildPayload(dispute, stored.draft);
    if (payload.kind !== "provide-evidence") throw new Error("expected a contest payload");
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

describe("relevantFacts", () => {
  it("highlights delivery facts for non-receipt and refunds for duplicates", () => {
    expect(relevantFacts("MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).toEqual(
      new Set(["delivery", "address", "signature"]),
    );
    expect(relevantFacts("UNAUTHORISED").has("delivery")).toBe(true);
    expect(relevantFacts("DUPLICATE_TRANSACTION")).toEqual(new Set(["refunds"]));
    expect(relevantFacts("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")).toEqual(
      new Set(["listing", "refunds"]),
    );
    expect(relevantFacts("CANCELED_RECURRING_BILLING")).toEqual(new Set(["access"]));
  });
});

describe("plain-language helpers", () => {
  it("takes the first sentence of the reasoning and caps its length", () => {
    expect(firstSentence("Delivery is confirmed. The address matches.")).toBe(
      "Delivery is confirmed.",
    );
    expect(firstSentence("No full stop here")).toBe("No full stop here");
    expect(firstSentence("")).toBe("");
    const long = firstSentence(`${"word ".repeat(80)}done.`, 100);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("\u2026")).toBe(true);
  });

  it("does not split a sentence on a decimal point or an abbreviation-like dot inside a number", () => {
    expect(firstSentence("Refund of $12.50 was issued. Buyer agreed.")).toBe(
      "Refund of $12.50 was issued.",
    );
  });

  it("turns SCREAMING_CASE codes in agent text into lower-case words", () => {
    expect(plainWords("filed a MERCHANDISE_OR_SERVICE_NOT_RECEIVED dispute")).toBe(
      "filed a merchandise or service not received dispute",
    );
    expect(plainWords("Status OK and PP-D-1001 stay as written")).toBe(
      "Status OK and PP-D-1001 stay as written",
    );
    expect(plainWords("")).toBe("");
  });

  it("words the decision for each recommendation", () => {
    expect(decisionHeadline("ACCEPT", null)).toBe("Accept this claim");
    expect(decisionHeadline("CONTEST", null)).toBe("Contest this dispute");
    expect(decisionHeadline("OFFER_PARTIAL", "$20.00")).toBe("Offer a partial refund of $20.00");
    expect(decisionHeadline("OFFER_PARTIAL", null)).toBe("Offer a partial refund");
  });

  it("maps confidence to a word", () => {
    expect(confidenceWord(0.9)).toBe("High");
    expect(confidenceWord(0.6)).toBe("Medium");
    expect(confidenceWord(0.2)).toBe("Low");
  });

  it("says when a response is due in words and marks the urgency", () => {
    expect(dueWords(inHours(-5), NOW)).toEqual({ text: "Overdue", tone: "urgent" });
    expect(dueWords(inHours(3), NOW)).toEqual({ text: "Due in 3 hours", tone: "urgent" });
    expect(dueWords(inHours(0.2), NOW)).toEqual({ text: "Due in 1 hour", tone: "urgent" });
    expect(dueWords(inHours(30), NOW)).toEqual({ text: "Due tomorrow", tone: "warn" });
    expect(dueWords(inHours(60), NOW)).toEqual({ text: "Due in 2 days", tone: "warn" });
    expect(dueWords(inHours(24 * 6), NOW)).toEqual({ text: "Due in 6 days", tone: "ok" });
    expect(dueWords(null, NOW)).toEqual({ text: "No deadline", tone: "none" });
  });

  it("summarises what will be sent for each kind of request", () => {
    const evidence = {
      kind: "provide-evidence",
      request: {
        evidences: [
          { evidence_type: "PROOF_OF_FULFILLMENT", notes: "x" },
          { evidence_type: "OTHER", notes: "y" },
        ],
      },
    } as never;
    expect(sendSummary(evidence, "$50.00").headline).toBe(
      "Contest this dispute with 2 pieces of evidence",
    );
    const one = {
      kind: "provide-evidence",
      request: { evidences: [{ evidence_type: "OTHER", notes: "y" }] },
    } as never;
    expect(sendSummary(one, "$50.00").headline).toBe(
      "Contest this dispute with 1 piece of evidence",
    );
    const accept = {
      kind: "accept-claim",
      request: { note: "n", accept_claim_reason: "DID_NOT_SHIP_ITEM" },
    } as never;
    expect(sendSummary(accept, "$50.00").headline).toBe("Accept the buyer's claim for $50.00");
    expect(sendSummary(accept, "$50.00").points.join(" ")).toContain("did not ship item");
    const offer = {
      kind: "make-offer",
      request: {
        note: "n",
        offer_amount: { currency_code: "USD", value: "20.00" },
        offer_type: "REFUND",
      },
    } as never;
    expect(sendSummary(offer, "$50.00").headline).toBe(
      "Offer the buyer a partial refund of 20.00 USD",
    );
  });
});

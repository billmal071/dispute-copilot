import { describe, expect, it } from "vitest";
import { scoreDraft } from "../src/agent/score.js";
import { addr, dispute, draft, NOW, runs, tracking, txn } from "./helpers.js";

const base = () => ({ dispute: dispute(), draft: draft(), toolRuns: runs(), now: NOW });
const part = (r: ReturnType<typeof scoreDraft>, key: string) => {
  const p = r.breakdown.find((b) => b.key === key);
  if (!p) throw new Error(`no component ${key}`);
  return p;
};

describe("scoreDraft", () => {
  it("gives 100 to a fully grounded contest with verified delivery", () => {
    const r = scoreDraft(base());
    expect(r.total).toBe(100);
    expect(r.breakdown.map((b) => b.points).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("is deterministic", () => {
    expect(scoreDraft(base())).toEqual(scoreDraft(base()));
  });

  it("awards required evidence proportionally", () => {
    const r = scoreDraft({
      ...base(),
      dispute: dispute({ reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" }),
    });
    expect(part(r, "required_evidence").points).toBe(15);
  });

  it("requires tracking on a fulfillment item for not-received disputes", () => {
    const d = draft();
    const first = d.evidences[0];
    if (!first) throw new Error("fixture");
    delete first.tracking;
    expect(part(scoreDraft({ ...base(), draft: d }), "required_evidence").points).toBe(0);
  });

  it("withholds delivery verification when tracking is not delivered", () => {
    const r = scoreDraft({
      ...base(),
      toolRuns: runs(txn(), tracking({ status: "IN_TRANSIT", delivered_at: null })),
    });
    expect(part(r, "delivery_verified").points).toBe(0);
  });

  it("withholds delivery verification when the delivery address differs", () => {
    const other = { ...addr, line1: "99 Other Street", postal_code: "900001" };
    const r = scoreDraft({
      ...base(),
      toolRuns: runs(txn(), tracking({ delivery_address: other })),
    });
    expect(part(r, "delivery_verified").points).toBe(0);
  });

  it("accepts digital access logs as verified fulfillment", () => {
    const logs = [{ at: "2026-10-21T10:00:00Z", event: "login" }];
    const r = scoreDraft({ ...base(), toolRuns: runs(txn({ access_logs: logs }), null) });
    expect(part(r, "delivery_verified").points).toBe(25);
  });

  it("penalises a citation that does not exist in the run", () => {
    const d = draft();
    d.evidences[0]?.source_refs.push("tracking:INVENTED");
    const r = scoreDraft({ ...base(), draft: d });
    expect(part(r, "grounded_citations").points).toBe(0);
    expect(r.penalties.map((p) => p.key)).toContain("unsupported_claim");
    expect(r.total).toBe(65);
    expect(r.warnings.join(" ")).toMatch(/INVENTED/);
  });

  it("penalises a tracking number that no tool returned", () => {
    const d = draft();
    if (d.evidences[0]) d.evidences[0].tracking = { carrier: "DHL", number: "FAKE999" };
    const r = scoreDraft({ ...base(), draft: d });
    expect(r.penalties.map((p) => p.key)).toContain("unsupported_claim");
    expect(r.warnings.join(" ")).toMatch(/FAKE999/);
  });

  it("requires every evidence item to cite at least one source", () => {
    const d = draft();
    if (d.evidences[0]) d.evidences[0].source_refs = [];
    expect(part(scoreDraft({ ...base(), draft: d }), "grounded_citations").points).toBe(0);
  });

  it("withholds specificity when notes mention no order id, amount or date", () => {
    const d = draft();
    if (d.evidences[0]) d.evidences[0].notes = "Item was delivered, please side with us.";
    expect(part(scoreDraft({ ...base(), draft: d }), "specific_notes").points).toBe(0);
  });

  it("awards the policy citation only when a policy ref exists in the run", () => {
    const d = draft();
    if (d.evidences[0]) d.evidences[0].source_refs = ["tracking:TXN-1", "transaction:TXN-1"];
    expect(part(scoreDraft({ ...base(), draft: d }), "policy_cited").points).toBe(0);
  });

  it("loses timing points when answered within 48 hours of the due date", () => {
    const r = scoreDraft({
      ...base(),
      dispute: dispute({ seller_response_due_date: "2026-11-11T12:00:00Z" }),
    });
    expect(part(r, "timely").points).toBe(0);
    expect(r.total).toBe(90);
  });

  it("penalises contesting after a full refund was issued", () => {
    const refunded = txn({
      refunds: [
        {
          id: "R1",
          amount: { currency_code: "USD", value: "89.00" },
          created: "2026-10-30T00:00:00Z",
        },
      ],
    });
    const r = scoreDraft({ ...base(), toolRuns: runs(refunded) });
    expect(r.penalties.map((p) => p.key)).toContain("contradiction");
  });

  it("penalises contesting a parcel the carrier lost", () => {
    const r = scoreDraft({
      ...base(),
      toolRuns: runs(txn(), tracking({ status: "LOST", delivered_at: null })),
    });
    expect(r.penalties.map((p) => p.key)).toContain("contradiction");
  });

  it("scores an accepted claim on grounding only, normalised to 100", () => {
    const d = draft({
      recommendation: "ACCEPT",
      evidences: [],
      reasoning: "Carrier marked the parcel lost on 2026-10-28.",
    });
    const r = scoreDraft({
      ...base(),
      draft: d,
      toolRuns: runs(txn(), tracking({ status: "LOST", delivered_at: null, signed_by: null })),
    });
    expect(part(r, "required_evidence").applicable).toBe(false);
    expect(r.penalties).toEqual([]);
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(r.total).toBeLessThanOrEqual(100);
  });

  it("penalises accepting a claim when delivery is verified and signed", () => {
    const r = scoreDraft({ ...base(), draft: draft({ recommendation: "ACCEPT", evidences: [] }) });
    expect(r.penalties.map((p) => p.key)).toContain("contradiction");
  });

  it("never drops below zero", () => {
    const d = draft({ evidences: [] });
    const r = scoreDraft({
      ...base(),
      draft: d,
      dispute: dispute({ seller_response_due_date: "2026-11-10T13:00:00Z" }),
      toolRuns: runs(
        txn({
          refunds: [
            {
              id: "R",
              amount: { currency_code: "USD", value: "89.00" },
              created: "2026-10-30T00:00:00Z",
            },
          ],
        }),
        tracking({ status: "LOST", delivered_at: null }),
      ),
    });
    expect(r.total).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreDraft contradiction scope", () => {
  it("does not penalise accepting a duplicate charge just because delivery was signed", () => {
    const r = scoreDraft({
      ...base(),
      dispute: dispute({ reason: "DUPLICATE_TRANSACTION" }),
      draft: draft({
        recommendation: "ACCEPT",
        evidences: [],
        reasoning: "Refund issued on 2026-11-08 for transaction TXN-1.",
      }),
    });
    expect(r.penalties).toEqual([]);
  });
});

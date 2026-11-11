import type { Payload } from "../actions/approve.js";
import type { StoredDraft } from "../agent/draft.js";
import type { Dispute } from "../types.js";

export interface InboxRow {
  dispute: Dispute;
  draft: {
    recommendation: string;
    score: number;
    version: number;
    offerAmount: number | null;
  } | null;
  decision: string | null;
}

export interface RankedRow {
  row: InboxRow;
  rank: number;
  actionable: boolean;
  winChance: number | null;
  scored: boolean;
  expectedValue: number;
  priority: number;
}

export interface Totals {
  atStake: number;
  dueSoon: number;
  recoverable: number;
  unscored: number;
}

const HOUR = 3600000;
const RING_WINDOW_HOURS = 168;
const UNSCORED_PRIOR = 0.5;

export function winChance(draft: { recommendation: string; score: number }): number | null {
  return draft.recommendation === "CONTEST" ? draft.score / 100 : null;
}

const urgencyFactor = (hours: number | null): number =>
  hours === null ? 1 : hours <= 0 ? 6 : 1 + 5 * Math.exp(-hours / 36);

const hoursLeft = (due: string | null, now: Date): number | null =>
  due ? (new Date(due).getTime() - now.getTime()) / HOUR : null;

function estimate(row: InboxRow): Pick<RankedRow, "winChance" | "scored" | "expectedValue"> {
  const amount = Number(row.dispute.dispute_amount.value);
  const { draft } = row;
  if (!draft) return { winChance: null, scored: false, expectedValue: amount * UNSCORED_PRIOR };
  const chance = winChance(draft);
  if (chance !== null) return { winChance: chance, scored: true, expectedValue: amount * chance };
  const kept = draft.recommendation === "OFFER_PARTIAL" ? amount - (draft.offerAmount ?? 0) : 0;
  return { winChance: null, scored: true, expectedValue: Math.max(0, kept) };
}

export function rankRows(rows: InboxRow[], now: Date): { ranked: RankedRow[]; totals: Totals } {
  const scoredRows = rows.map((row) => {
    const actionable = row.dispute.status === "WAITING_FOR_SELLER_RESPONSE" && !row.decision;
    const value = estimate(row);
    const hours = hoursLeft(row.dispute.seller_response_due_date, now);
    return {
      row,
      actionable,
      ...value,
      priority: value.expectedValue * urgencyFactor(hours),
    };
  });
  scoredRows.sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    if (a.actionable && b.priority !== a.priority) return b.priority - a.priority;
    const due = (r: typeof a) => r.row.dispute.seller_response_due_date ?? "9";
    return (
      due(a).localeCompare(due(b)) ||
      a.row.dispute.dispute_id.localeCompare(b.row.dispute.dispute_id)
    );
  });
  const ranked = scoredRows.map((r, i) => ({ ...r, rank: i + 1 }));

  const open = ranked.filter((r) => r.actionable);
  const totals: Totals = {
    atStake: open.reduce((s, r) => s + Number(r.row.dispute.dispute_amount.value), 0),
    dueSoon: open.filter((r) => {
      const h = hoursLeft(r.row.dispute.seller_response_due_date, now);
      return h !== null && h <= 48;
    }).length,
    recoverable: open.filter((r) => r.scored).reduce((s, r) => s + r.expectedValue, 0),
    unscored: open.filter((r) => !r.scored).length,
  };
  return { ranked, totals };
}

export interface Ring {
  fraction: number;
  tone: "ok" | "warn" | "urgent" | "none";
  label: string;
  sr: string;
}

export function deadlineRing(due: string | null, now: Date): Ring {
  const hours = hoursLeft(due, now);
  if (hours === null) return { fraction: 0, tone: "none", label: "None", sr: "No deadline" };
  if (hours <= 0) return { fraction: 0, tone: "urgent", label: "Late", sr: "Response is overdue" };
  const fraction = Math.min(1, hours / RING_WINDOW_HOURS);
  if (hours < 24) {
    const h = Math.max(1, Math.round(hours));
    return { fraction, tone: "urgent", label: `${h}h`, sr: `${h} hours left` };
  }
  const days = Math.floor(hours / 24);
  return {
    fraction,
    tone: hours < 72 ? "warn" : "ok",
    label: `${days}d`,
    sr: `${days} days left`,
  };
}

export type ChecklistState = "have" | "weak" | "missing";

export interface ChecklistItem {
  key: string;
  label: string;
  state: ChecklistState;
  detail: string;
  collect: string;
  source: "score" | "agent";
}

const COLLECT: Record<string, string> = {
  required_evidence: "Attach the required evidence types for this dispute reason.",
  delivery_verified: "Get a delivered scan with a matching address, or proof the buyer used it.",
  grounded_citations: "Re-run the draft so every claim cites a record that was fetched.",
  specific_notes: "Add the order id, amount or a date to each note.",
  policy_cited: "Cite the merchant policy that applies.",
  timely: "Submit now; less than 48 hours remain before the response is due.",
};
const HARD_REQUIREMENTS = new Set(["required_evidence", "delivery_verified", "policy_cited"]);

export function checklistFor(stored: StoredDraft): ChecklistItem[] {
  const fromScore = stored.scoreResult.breakdown
    .filter((p) => p.applicable)
    .map((p): ChecklistItem => {
      const state: ChecklistState =
        p.points >= p.max
          ? "have"
          : p.points === 0 && HARD_REQUIREMENTS.has(p.key)
            ? "missing"
            : "weak";
      return {
        key: p.key,
        label: p.label,
        state,
        detail: p.reason,
        collect: state === "have" ? "" : (COLLECT[p.key] ?? "Review this item."),
        source: "score",
      };
    });
  const fromAgent = stored.draft.missing_evidence.map(
    (text, i): ChecklistItem => ({
      key: `agent_${i}`,
      label: text,
      state: "missing",
      detail: "Flagged by the agent: not available from PayPal data.",
      collect: "Merchant input needed. Supply this before contesting.",
      source: "agent",
    }),
  );
  return [...fromScore, ...fromAgent];
}

export interface OutboundRequest {
  method: "POST";
  url: string;
  headers: [string, string][];
  bodyLabel: string;
  body: string;
  notSent: string | null;
}

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export function outboundRequest(
  payload: Payload,
  disputeId: string,
  requestId: string,
  mode: "mock" | "sandbox",
): OutboundRequest {
  const multipart = payload.kind === "provide-evidence";
  const body = multipart
    ? { evidences: payload.request.evidences }
    : (payload.request as unknown as object);
  return {
    method: "POST",
    url: `${SANDBOX_BASE}/v1/customer/disputes/${encodeURIComponent(disputeId)}/${payload.kind}`,
    headers: [
      ["Authorization", "Bearer [redacted: added at send time]"],
      ["Accept", "application/json"],
      ["PayPal-Request-Id", requestId],
      ["Content-Type", multipart ? "multipart/form-data" : "application/json"],
    ],
    bodyLabel: multipart ? 'multipart part "input" (application/json, input.json)' : "JSON body",
    body: JSON.stringify(body, null, 2),
    notSent:
      mode === "mock"
        ? "Mock mode: this goes to the built-in PayPal simulator and never leaves this machine."
        : null,
  };
}

export function firstSentence(text: string, max = 190): string {
  const trimmed = text.trim();
  const end = /[.!?](?=\s+[A-Z"(]|$)/.exec(trimmed);
  const sentence = end ? trimmed.slice(0, end.index + 1) : trimmed;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : cut.length).trimEnd()}\u2026`;
}

export function plainWords(text: string): string {
  return text.replace(/\b[A-Z]{2,}(?:_[A-Z]+)+\b/g, (code) =>
    code.toLowerCase().replace(/_/g, " "),
  );
}

export function decisionHeadline(recommendation: string, offerAmount: string | null): string {
  if (recommendation === "ACCEPT") return "Accept this claim";
  if (recommendation === "CONTEST") return "Contest this dispute";
  return offerAmount ? `Offer a partial refund of ${offerAmount}` : "Offer a partial refund";
}

export function confidenceWord(confidence: number): "High" | "Medium" | "Low" {
  return confidence >= 0.8 ? "High" : confidence >= 0.5 ? "Medium" : "Low";
}

export interface DueWords {
  text: string;
  tone: "urgent" | "warn" | "ok" | "none";
}

export function dueWords(due: string | null, now: Date): DueWords {
  const hours = hoursLeft(due, now);
  if (hours === null) return { text: "No deadline", tone: "none" };
  if (hours <= 0) return { text: "Overdue", tone: "urgent" };
  if (hours < 24) {
    const n = Math.max(1, Math.round(hours));
    return { text: `Due in ${n} ${n === 1 ? "hour" : "hours"}`, tone: "urgent" };
  }
  const days = Math.floor(hours / 24);
  const tone = hours < 72 ? "warn" : "ok";
  return { text: days === 1 ? "Due tomorrow" : `Due in ${days} days`, tone };
}

export interface SendSummary {
  headline: string;
  points: string[];
}

export function sendSummary(payload: Payload, amount: string): SendSummary {
  switch (payload.kind) {
    case "provide-evidence": {
      const n = payload.request.evidences.length;
      return {
        headline: `Contest this dispute with ${n} ${n === 1 ? "piece" : "pieces"} of evidence`,
        points: [
          "PayPal reviews your evidence and decides the dispute.",
          "Until PayPal decides, the dispute stays open.",
        ],
      };
    }
    case "accept-claim":
      return {
        headline: `Accept the buyer's claim for ${amount}`,
        points: [
          `Reason given to PayPal: ${payload.request.accept_claim_reason.replace(/_/g, " ").toLowerCase()}.`,
          `The buyer is refunded ${amount} and the dispute closes in their favour.`,
        ],
      };
    case "make-offer": {
      const o = payload.request.offer_amount;
      return {
        headline: `Offer the buyer a partial refund of ${o.value} ${o.currency_code}`,
        points: [
          "The buyer can accept or decline the offer.",
          "If they decline, the dispute stays open and can escalate.",
        ],
      };
    }
  }
}

export type RouteKey = "inbox" | "dispute" | "audit" | "notfound" | "error";

export interface PageMeta {
  title: string;
  description: string;
}

export function pageMeta(key: RouteKey, ctx: { id?: string } = {}): PageMeta {
  switch (key) {
    case "inbox":
      return {
        title: "Dispute inbox",
        description:
          "Open PayPal disputes ranked by urgency and expected recovery, each with a drafted evidence response waiting for your approval.",
      };
    case "dispute":
      return {
        title: `Dispute ${ctx.id ?? ""}`.trim(),
        description:
          "Review the case file, the agent's drafted evidence, the win chance and the exact PayPal request before you approve anything.",
      };
    case "audit":
      return {
        title: "Audit trail",
        description:
          "Every agent step, human decision and PayPal exchange, chained by SHA-256 hashes so tampering shows up as a broken link.",
      };
    case "notfound":
      return {
        title: "Page not found",
        description:
          "That page does not exist in Dispute Copilot. Head back to the inbox to see your open PayPal disputes and drafts.",
      };
    case "error":
      return {
        title: "Something went wrong",
        description:
          "Dispute Copilot hit an unexpected error. It was logged, and your drafts, decisions and audit trail are unaffected.",
      };
  }
}

export type Fact = "delivery" | "address" | "signature" | "refunds" | "listing" | "access";

export function relevantFacts(reason: Dispute["reason"]): Set<Fact> {
  switch (reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
    case "UNAUTHORISED":
      return new Set<Fact>(["delivery", "address", "signature"]);
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return new Set<Fact>(["listing", "refunds"]);
    case "DUPLICATE_TRANSACTION":
    case "CREDIT_NOT_PROCESSED":
      return new Set<Fact>(["refunds"]);
    case "CANCELED_RECURRING_BILLING":
      return new Set<Fact>(["access"]);
    case "OTHER":
      return new Set<Fact>();
  }
}

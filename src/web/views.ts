import type { Payload } from "../actions/approve.js";
import type { StoredDraft } from "../agent/draft.js";
import { sameAddress } from "../agent/facts.js";
import { provenanceLabel } from "../agent/provenance.js";
import type { AuditRow, ChainResult } from "../audit.js";
import type { Dispute, DisputeReason, Order, ToolRun, Tracking, Transaction } from "../types.js";
import { h, raw, type Safe } from "./html.js";
import { icon, sealMark } from "./icons.js";
import {
  checklistFor,
  confidenceWord,
  deadlineRing,
  decisionHeadline,
  dueWords,
  type Fact,
  firstSentence,
  type InboxRow,
  outboundRequest,
  type PageMeta,
  plainWords,
  type RankedRow,
  type Ring,
  rankRows,
  relevantFacts,
  sendSummary,
  winChance,
} from "./insight.js";

export type { InboxRow } from "./insight.js";

export const REASON_LABEL: Record<DisputeReason, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  CANCELED_RECURRING_BILLING: "Subscription cancelled",
  OTHER: "Other",
};

export const REASON_PLAIN: Record<DisputeReason, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "The buyer says the item never arrived.",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "The buyer says the item was not as described.",
  UNAUTHORISED: "The buyer says they did not authorise this payment.",
  DUPLICATE_TRANSACTION: "The buyer says they were charged twice for the same order.",
  CREDIT_NOT_PROCESSED: "The buyer says a promised refund never arrived.",
  CANCELED_RECURRING_BILLING:
    "The buyer says they cancelled this subscription but were still charged.",
  OTHER: "The buyer opened a dispute that PayPal files under Other.",
};

const REC_WORD: Record<string, string> = {
  ACCEPT: "Accept",
  CONTEST: "Contest",
  OFFER_PARTIAL: "Partial offer",
};

const STATUS: Record<string, { label: string; tone: string }> = {
  WAITING_FOR_SELLER_RESPONSE: { label: "Waiting for you", tone: "amber" },
  WAITING_FOR_BUYER_RESPONSE: { label: "Waiting for buyer", tone: "gray" },
  UNDER_REVIEW: { label: "Under review", tone: "blue" },
  RESOLVED: { label: "Resolved", tone: "green" },
  OPEN: { label: "Open", tone: "gray" },
  OTHER: { label: "Other", tone: "gray" },
};

export const statusChip = (status: string): Safe => {
  const s = STATUS[status] ?? { label: status, tone: "gray" };
  return h`<span class="chip ${s.tone}">${s.label}</span>`;
};

export const money = (m: { currency_code: string; value: string }): string =>
  formatMoney(Number(m.value), m.currency_code);

const formatMoney = (value: number, currency: string, whole = false): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    ...(whole ? { maximumFractionDigits: 0, minimumFractionDigits: 0 } : {}),
  }).format(value);

const dateFmt = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "-";

const dateTimeFmt = (iso: string) =>
  `${new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

export function timeLeft(due: string | null, now: Date): Safe {
  if (!due) return h`<span class="sub">No deadline</span>`;
  const hours = (new Date(due).getTime() - now.getTime()) / 3600000;
  if (hours < 0) return h`<span class="due-urgent">Overdue</span>`;
  if (hours < 24) return h`<span class="due-urgent">${Math.max(1, Math.round(hours))}h left</span>`;
  const days = Math.floor(hours / 24);
  return h`<span class="${hours < 72 ? "due-warn" : ""}">${days}d left</span>`;
}

export function deadlineRingView(ring: Ring, size: "sm" | "lg" = "sm"): Safe {
  return h`<span class="ring ${ring.tone}" data-size="${size}" role="img" aria-label="${ring.sr}"><svg viewBox="0 0 44 44" aria-hidden="true"><circle class="ring-track" cx="22" cy="22" r="18"/><circle class="ring-fill" cx="22" cy="22" r="18" pathLength="100" stroke-dasharray="${(ring.fraction * 100).toFixed(1)} 100" transform="rotate(-90 22 22)"/></svg><b>${ring.label}</b></span>`;
}

type Tone = "strong" | "fair" | "weak";
const toneOf = (pct: number): Tone => (pct >= 80 ? "strong" : pct >= 50 ? "fair" : "weak");
const TONE_WORD: Record<Tone, string> = { strong: "Strong", fair: "Fair", weak: "Weak" };
const TONE_ICON: Record<Tone, Safe> = {
  strong: icon.checkCircle,
  fair: icon.halfCircle,
  weak: icon.alert,
};

const GAUGE_R = 84;
const GAUGE_C = 2 * Math.PI * GAUGE_R;
const GAUGE_ARC = GAUGE_C * 0.75;

export function gauge(score: number, contest: boolean): Safe {
  const pct = contest ? score : 0;
  const tone = toneOf(pct);
  const fill = (GAUGE_ARC * pct) / 100;
  const tick = (at: number) => {
    const a = ((135 + 270 * (at / 100)) * Math.PI) / 180;
    const [x1, y1] = [100 + (GAUGE_R - 11) * Math.cos(a), 100 + (GAUGE_R - 11) * Math.sin(a)];
    const [x2, y2] = [100 + (GAUGE_R + 11) * Math.cos(a), 100 + (GAUGE_R + 11) * Math.sin(a)];
    return h`<line class="g-tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  };
  return h`<div class="gauge ${contest ? tone : "none"}" ${contest ? raw(`data-score="${score}" data-gauge="${score}"`) : ""} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${contest ? `Estimated win chance ${score} percent` : "Win chance not applicable: the agent does not recommend contesting"}" style="--arc:${GAUGE_ARC.toFixed(2)};--fill:${fill.toFixed(2)}">
  <svg viewBox="0 0 200 200" aria-hidden="true">
    <circle class="g-track" cx="100" cy="100" r="${GAUGE_R}" stroke-dasharray="${GAUGE_ARC.toFixed(2)} ${GAUGE_C.toFixed(2)}" transform="rotate(135 100 100)"/>
    ${contest ? h`<circle class="g-fill" cx="100" cy="100" r="${GAUGE_R}" stroke-dasharray="${fill.toFixed(2)} ${GAUGE_C.toFixed(2)}" transform="rotate(135 100 100)"/>` : ""}
    ${tick(50)}${tick(80)}
  </svg>
  <div class="g-read">
    <span class="g-num">${contest ? h`${score}<small>%</small>` : "n/a"}</span>
    <span class="g-label">${contest ? "win chance" : "not contesting"}</span>
  </div>
  ${contest ? h`<span class="g-tone">${TONE_ICON[tone]}${TONE_WORD[tone]}</span>` : ""}
</div>`;
}

const CSRF_MARKER = "__CSRF_TOKEN__";
const csrfInput = raw(`<input type="hidden" name="csrf_token" value="${CSRF_MARKER}">`);

export interface LayoutOptions {
  meta: PageMeta;
  mode: "mock" | "sandbox";
  nav: "inbox" | "audit" | "";
  now: Date;
  csrf: string;
}

export function layout(opts: LayoutOptions, body: Safe): string {
  const { meta } = opts;
  const fullTitle = `${meta.title} · Dispute Copilot`;
  const clockNote =
    opts.mode === "mock"
      ? h`<span class="demo-clock" title="Mock mode uses a fixed demo clock so scripted fixtures stay valid"><span class="dot" aria-hidden="true"></span>Demo clock ${dateTimeFmt(opts.now.toISOString())}</span>`
      : "";
  return h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${meta.description}">
<meta name="theme-color" content="#f4f0e6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1114" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dispute Copilot">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${meta.description}">
<meta property="og:image" content="/icon-512.png">
<meta property="og:image:alt" content="Dispute Copilot mark: an open deadline ring with a check">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${meta.description}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preload" href="/assets/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/instrument-serif-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css">
<script>try{var t=localStorage.getItem("dc-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<script src="/assets/htmx.js" defer></script>
<script src="/assets/app.js" defer></script>
</head>
<body hx-boost="false" hx-headers='{"X-CSRF-Token":"${opts.csrf}"}'>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="topbar-inner">
  <a class="brand" href="/" aria-label="Dispute Copilot, inbox">${sealMark}<span class="brand-name">Dispute Copilot</span></a>
  <nav class="nav" aria-label="Primary">
    <a href="/" ${opts.nav === "inbox" ? raw('aria-current="page"') : ""}>Inbox</a>
    <a href="/audit" ${opts.nav === "audit" ? raw('aria-current="page"') : ""}>Audit trail</a>
  </nav>
  <div class="topbar-right">${clockNote}<span class="mode ${opts.mode}">${opts.mode.toUpperCase()}</span>
    <button class="icon-btn" type="button" id="theme-toggle" aria-label="Switch colour theme"><span class="show-light">${icon.moon}</span><span class="show-dark">${icon.sun}</span></button>
  </div>
</div></header>
<main id="main">${body}</main>
<footer class="foot"><div class="foot-inner"><span>${sealMark} Nothing is sent to PayPal until a person approves it.</span><span>${opts.mode === "mock" ? "Mock mode: seeded disputes, scripted demo drafts unless a model key is set." : "Sandbox mode: calls api-m.sandbox.paypal.com."}</span></div></footer>
</body>
</html>`
    .toString()
    .replaceAll(CSRF_MARKER, opts.csrf);
}

function agentState(row: InboxRow): Safe {
  const { draft, decision } = row;
  if (decision === "reject") return h`<span class="state done">${icon.x}Rejected</span>`;
  if (decision) return h`<span class="state sent">${icon.send}Sent to PayPal</span>`;
  if (draft)
    return h`<span class="state drafted">${icon.file}Draft ready<span class="state-sub">${REC_WORD[draft.recommendation] ?? draft.recommendation} · v${draft.version}</span></span>`;
  return h`<span class="state none">${icon.flag}Needs a draft</span>`;
}

function winCell(r: RankedRow): Safe {
  const { draft } = r.row;
  if (!draft) return h`<span class="win none" title="No draft yet, so no win chance">-</span>`;
  if (r.winChance === null)
    return h`<span class="win text">${draft.recommendation === "ACCEPT" ? "Concede" : "Settle"}</span>`;
  const pct = Math.round(r.winChance * 100);
  const tone = toneOf(pct);
  return h`<span class="win ${tone}" data-win="${pct}"><span class="win-bar" role="img" aria-label="${pct} percent win chance, ${TONE_WORD[tone]}"><i style="--w:${pct}%"></i></span><b>${pct}%</b></span>`;
}

function caseRow(r: RankedRow, now: Date): Safe {
  const d = r.row.dispute;
  const buyer = d.disputed_transactions[0]?.buyer.name ?? "Unknown buyer";
  const due = dueWords(d.seller_response_due_date, now);
  return h`<li class="case ${r.actionable ? "" : "settled"}" data-dispute-row data-id="${d.dispute_id}" style="--i:${r.rank}">
  <div class="case-due ${due.tone}">${deadlineRingView(deadlineRing(d.seller_response_due_date, now))}<span class="due-words">${due.text}</span></div>
  <div class="case-main">
    <a class="case-link" href="/disputes/${d.dispute_id}">${buyer}</a>
    <span class="case-sub">${REASON_LABEL[d.reason]}<span aria-hidden="true">·</span><span class="mono">${d.dispute_id}</span></span>
  </div>
  <div class="case-amount tnum">${money(d.dispute_amount)}</div>
  <div class="case-win">${winCell(r)}</div>
  <div class="case-state">${agentState(r.row)}${statusChip(d.status)}</div>
  <span class="case-go" aria-hidden="true">${icon.arrow}</span>
</li>`;
}

export function inboxPage(rows: InboxRow[], now: Date, mode: "mock" | "sandbox"): Safe {
  const head = (action: Safe | "") => h`<div class="page-head">
    <div><span class="eyebrow">${dateFmt(now.toISOString())}</span><h1>Your disputes</h1></div>
    <div class="head-actions">${action}<form method="post" action="/sync">${csrfInput}<button class="btn ghost" type="submit">${icon.sync}Sync now</button></form></div>
  </div>`;
  if (rows.length === 0) {
    return h`${head("")}<div class="panel empty">
      <svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true"><rect x="22" y="10" width="76" height="76" rx="8" class="ea-sheet"/><path d="M36 30h48M36 42h48M36 54h30" class="ea-line"/><circle cx="86" cy="70" r="14" class="ea-ring"/><path d="M80 70l4 4 8-9" class="ea-check"/></svg>
      <h2>No disputes yet</h2><p>Sync with ${mode === "mock" ? "the seeded mock data" : "PayPal"} to load your open disputes.</p>
      <form method="post" action="/sync">${csrfInput}<button class="btn primary" type="submit">Sync now</button></form></div>`;
  }
  const { ranked, totals } = rankRows(rows, now);
  const currency = rows[0]?.dispute.dispute_amount.currency_code ?? "USD";
  const open = ranked.filter((r) => r.actionable);
  const done = ranked.filter((r) => !r.actionable);
  const top = open[0];
  const recoverPct =
    totals.atStake > 0 ? Math.round((totals.recoverable / totals.atStake) * 100) : 0;
  const next = top
    ? h`<a class="btn primary next-case" href="/disputes/${top.row.dispute.dispute_id}">Work the next case${icon.arrow}</a>`
    : "";
  return h`${head(next)}
<section class="strip" aria-label="Summary">
  <div class="stat"><span class="stat-label">Money at stake</span><span class="stat-fig tnum">${formatMoney(totals.atStake, currency, true)}</span><span class="stat-note">${open.length} open ${open.length === 1 ? "dispute" : "disputes"} waiting for you</span></div>
  <div class="stat"><span class="stat-label">Due within 48h</span><span class="stat-fig tnum">${totals.dueSoon}</span><span class="stat-note">${totals.dueSoon === 0 ? "Nothing urgent" : "Answer these first"}</span></div>
  <div class="stat wide"><span class="stat-label">Est. recoverable</span><span class="stat-fig tnum">${formatMoney(totals.recoverable, currency, true)}</span>
    <span class="meter" role="img" aria-label="${recoverPct} percent of the money at stake is estimated recoverable"><i style="--w:${recoverPct}%"></i></span>
    <span class="stat-note">${recoverPct}% of stake. Amount times evidence score for contests${totals.unscored > 0 ? `; ${totals.unscored} not drafted yet are excluded` : ""}. An estimate, not a prediction.</span></div>
</section>
<section aria-labelledby="open-h">
  <div class="list-head"><h2 id="open-h">Needs your response</h2><span class="sub">Most urgent and most valuable first</span></div>
  <ol class="docket">${open.map((r) => caseRow(r, now))}</ol>
</section>
${
  done.length > 0
    ? h`<section aria-labelledby="done-h" class="settled-block">
  <div class="list-head"><h2 id="done-h">Decided or with PayPal</h2></div>
  <ol class="docket">${done.map((r) => caseRow(r, now))}</ol></section>`
    : ""
}`;
}

export function notFoundPage(what: string, detail: string): Safe {
  return h`<div class="panel empty">
  <svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true"><rect x="22" y="10" width="76" height="76" rx="8" class="ea-sheet"/><path d="M36 30h48M36 42h48M36 54h30" class="ea-line"/><circle cx="86" cy="70" r="14" class="ea-ring warn"/><path d="M86 63v8M86 76v.5" class="ea-check warn"/></svg>
  <h2>${what}</h2><p>${detail}</p><a class="btn primary" href="/">${icon.back}Back to inbox</a></div>`;
}

export interface EvidenceView {
  dispute: Dispute;
  transaction: Transaction | { error: string };
  order: Order | { error: string } | null;
  tracking: Tracking | null | { error: string };
}

const hasError = <T extends object>(v: T | { error: string } | null): v is { error: string } =>
  !!v && "error" in v;

function addressLine(
  a: { line1: string; city: string; postal_code: string; country_code: string } | null,
) {
  return a ? `${a.line1}, ${a.city} ${a.postal_code}, ${a.country_code}` : "Not available";
}

const hl = (on: boolean, content: unknown): Safe =>
  on ? h`<mark class="hl">${content}</mark>` : h`${content}`;

function caseFile(ev: EvidenceView, now: Date): Safe {
  const d = ev.dispute;
  const facts: Set<Fact> = relevantFacts(d.reason);
  const txn = hasError(ev.transaction) ? null : ev.transaction;
  const tracking = ev.tracking && !hasError(ev.tracking) ? ev.tracking : null;
  const match =
    txn && tracking ? sameAddress(txn.shipping_address, tracking.delivery_address) : null;
  return h`<p class="legend"><mark class="hl">Highlighted</mark> facts are the ones that decide this kind of dispute.</p>
<section class="exhibit" aria-labelledby="ex-a">
  <header><span class="ex-tag">A</span><h2 id="ex-a">Buyer claim</h2>${statusChip(d.status)}</header>
  <dl class="kv">
    <dt>Reason</dt><dd>${REASON_LABEL[d.reason]}</dd>
    <dt>Amount</dt><dd class="tnum">${money(d.dispute_amount)}</dd>
    <dt>Respond by</dt><dd>${dateFmt(d.seller_response_due_date)} · ${timeLeft(d.seller_response_due_date, now)}</dd>
    <dt>Opened</dt><dd>${dateFmt(d.create_time)}</dd>
  </dl>
  ${d.messages.map((m) => h`<figure class="quote"><figcaption>${m.posted_by === "BUYER" ? "Buyer" : "Merchant"} · ${dateFmt(m.time_posted)}${m.posted_by === "BUYER" ? h`<span class="untrusted" title="Buyer-supplied text is shown as data and is never treated as an instruction by the agent.">${icon.shield}Untrusted text</span>` : ""}</figcaption><blockquote>${m.content}</blockquote></figure>`)}
</section>
<section class="exhibit" aria-labelledby="ex-b">
  <header><span class="ex-tag">B</span><h2 id="ex-b">Transaction</h2></header>
  ${
    txn
      ? h`<dl class="kv">
    <dt>Transaction</dt><dd class="mono">${txn.id}</dd>
    <dt>Order</dt><dd class="mono">${txn.order_id || "Not available"}</dd>
    <dt>Paid</dt><dd class="tnum">${money(txn.amount)} on ${dateFmt(txn.created)}</dd>
    <dt>Buyer</dt><dd>${txn.buyer.name || "Not available"}<div class="sub">${txn.buyer.email}</div></dd>
    <dt>Ship to</dt><dd>${hl(facts.has("address"), addressLine(txn.shipping_address))}</dd>
    <dt>Refunds</dt><dd>${txn.refunds.length === 0 ? "None" : txn.refunds.map((r) => h`<div>${hl(facts.has("refunds"), h`<span class="tnum">${money(r.amount)}</span> <span class="mono">${r.id}</span>`)} on ${dateFmt(r.created)}</div>`)}</dd>
  </dl>`
      : h`<div class="callout error">${icon.alert}<div>Transaction unavailable: ${(ev.transaction as { error: string }).error}</div></div>`
  }
</section>
${
  ev.order && !hasError(ev.order)
    ? h`<section class="exhibit" aria-labelledby="ex-c">
  <header><span class="ex-tag">C</span><h2 id="ex-c">Order</h2></header>
  <ul class="items">${ev.order.items.map((i) => h`<li><strong>${i.quantity} × ${i.name}</strong><span class="sub">${i.description}</span></li>`)}</ul>
  ${ev.order.listing_note ? h`<div class="callout warn">${icon.flag}<div>${hl(facts.has("listing"), h`Listing note: ${ev.order.listing_note}`)}</div></div>` : ""}
</section>`
    : ""
}
<section class="exhibit" aria-labelledby="ex-d">
  <header><span class="ex-tag">D</span><h2 id="ex-d">${txn?.access_logs ? "Access logs" : "Shipment"}</h2></header>
  ${
    txn?.access_logs
      ? h`<ol class="logs">${txn.access_logs.map((l) => h`<li>${hl(facts.has("access"), l.event.replace(/_/g, " "))}<span class="mono">${dateFmt(l.at)}</span></li>`)}</ol>`
      : tracking
        ? h`<dl class="kv">
    <dt>Carrier</dt><dd>${tracking.carrier} · <span class="mono">${tracking.tracking_number}</span></dd>
    <dt>Status</dt><dd>${tracking.status === "DELIVERED" ? hl(facts.has("delivery"), h`<span class="ok-mark">${icon.check}Delivered</span>`) : tracking.status === "LOST" ? hl(facts.has("delivery"), h`<span class="bad-mark">${icon.x}Lost</span>`) : hl(facts.has("delivery"), tracking.status.replace("_", " "))}</dd>
    <dt>Shipped</dt><dd>${dateFmt(tracking.shipped_at)}</dd>
    <dt>Delivered</dt><dd>${dateFmt(tracking.delivered_at)}${tracking.signed_by ? h` · ${hl(facts.has("signature"), `signed by ${tracking.signed_by}`)}` : ""}</dd>
    <dt>Delivered to</dt><dd>${addressLine(tracking.delivery_address)}</dd>
    <dt>Address check</dt><dd>${match === null ? "Not available" : match ? hl(facts.has("address"), h`<span class="ok-mark">${icon.check}Matches the transaction address</span>`) : hl(facts.has("address"), h`<span class="bad-mark">${icon.x}Differs from the transaction address</span>`)}</dd>
  </dl>`
        : h`<div class="callout warn">${icon.alert}<div>No tracking on file for this transaction.${hasError(ev.tracking) ? ` (${ev.tracking.error})` : ""}</div></div>`
  }
</section>`;
}

function traceView(trace: ToolRun[]): Safe {
  return h`${trace.map(
    (t) =>
      h`<details class="trace"><summary><span class="mono">${t.name}</span>${t.ref ? h`<span class="ref">${t.ref}</span>` : ""}${t.is_error ? h`<span class="chip red">error</span>` : ""}</summary><pre>${JSON.stringify(t.output, null, 2)}</pre></details>`,
  )}`;
}

export interface Decision {
  decision: "approve" | "reject" | "edit";
  decidedBy: string;
  decidedAt: string;
  action: {
    kind: string;
    status: string;
    attempts: number;
    response: unknown;
    request_id: string;
  } | null;
}

const modeName = (mode: "mock" | "sandbox") =>
  mode === "mock" ? "PayPal simulator" : "PayPal sandbox";

function auditMini(rows: AuditRow[], disputeId: string): Safe {
  return h`<div class="receipt-audit"><h3>Audit entry</h3>
  <ol class="mini-timeline">${rows.map((r) => h`<li><span class="mono when">${dateTimeFmt(r.ts)}</span><span>${r.actor} · ${r.event.replace(/_/g, " ")}</span><span class="hash mono" title="${r.hash}">#${r.id} ${r.hash.slice(0, 10)}</span></li>`)}</ol>
  <a class="btn small ghost" href="/audit?dispute=${disputeId}">${icon.link}View audit trail for ${disputeId}</a></div>`;
}

export function decisionPanel(
  draft: StoredDraft,
  decision: Decision,
  mode: "mock" | "sandbox",
  errorText?: string,
  audit: AuditRow[] = [],
): Safe {
  const rejected = decision.decision === "reject";
  const a = decision.action;
  const sent = !rejected && a?.status === "ok";
  const auditBlock = auditMini(audit, draft.dispute_id);
  return h`<div id="draft-panel" class="panel decision reveal">
  ${
    rejected
      ? h`<div class="stamp rejected" role="img" aria-label="Rejected"><span>Rejected</span></div>
      <h2 class="decision-title">Rejected</h2>
      <p class="lede">Nothing was sent to PayPal. Decided by ${decision.decidedBy} on ${dateTimeFmt(decision.decidedAt)}.</p>`
      : sent
        ? h`<div class="stamp" role="img" aria-label="Sent"><span>Sent</span><small>${modeName(mode)}</small></div>
      <h2 class="decision-title">Sent to PayPal${decision.decision === "edit" ? " with your edits" : ""}</h2>
      <p class="lede">${mode === "mock" ? "Delivered to the built-in simulator. " : ""}Dispute is now ${statusChip(String((a?.response as { status?: string } | null)?.status ?? "OTHER"))}</p>
      <dl class="kv receipt"><dt>Action</dt><dd class="mono">${a?.kind}</dd><dt>PayPal-Request-Id</dt><dd class="mono">${a?.request_id}</dd><dt>Attempts</dt><dd>${a?.attempts}</dd><dt>Approved by</dt><dd>${decision.decidedBy} · ${dateTimeFmt(decision.decidedAt)}</dd></dl>
      <details class="trace"><summary><span class="mono">PayPal response</span></summary><pre>${JSON.stringify(a?.response, null, 2)}</pre></details>`
        : a?.status === "in_flight"
          ? h`<div class="callout info">${icon.info}<div><strong>Submission in progress.</strong> The request is with PayPal. Reload in a moment; it will not be sent twice.</div></div>`
          : h`<div class="callout error">${icon.alert}<div><strong>PayPal did not accept the submission.</strong> ${errorText ?? ""} The draft is saved. Retrying reuses the same PayPal-Request-Id, so it cannot be applied twice.</div></div>
             <form class="retry" hx-post="/drafts/${draft.id}/approve" hx-target="#draft-panel" hx-swap="outerHTML" hx-disabled-elt="find button">
               <input type="hidden" name="idempotency_key" value="${a?.request_id ?? ""}">
               <input type="hidden" name="draft_id" value="${draft.id}">
               <input type="hidden" name="draft_version" value="${draft.version}">
               <button class="btn primary" type="submit">Retry submission</button></form>`
  }
  ${auditBlock}
</div>`;
}

function detailSection(
  title: string,
  summary: Safe | string,
  body: Safe,
  opts: { open?: boolean } = {},
): Safe {
  return h`<details class="dt" ${opts.open ? raw("open") : ""}><summary><span class="dt-title">${title}</span><span class="dt-sum">${summary}</span></summary><div class="dt-body">${body}</div></details>`;
}

export function draftPanel(
  draft: StoredDraft,
  ctx: {
    mode: "mock" | "sandbox";
    idempotencyKey: string;
    amount: { currency_code: string; value: string };
  },
): Safe {
  const d = draft.draft;
  const s = draft.scoreResult;
  const contest = d.recommendation === "CONTEST";
  const chance = winChance({ recommendation: d.recommendation, score: draft.score });
  const amount = Number(ctx.amount.value);
  const recover =
    chance !== null
      ? amount * chance
      : d.recommendation === "OFFER_PARTIAL" && d.offer
        ? Math.max(0, amount - Number(d.offer.amount))
        : 0;
  const offerMoney = d.offer
    ? money({ currency_code: ctx.amount.currency_code, value: d.offer.amount })
    : null;
  const ledger = checklistFor(draft);
  const count = (state: string) => ledger.filter((i) => i.state === state).length;
  const provenance = provenanceLabel(draft.model, draft.source);
  const scripted = provenance.note !== null;
  const sourceChip = scripted
    ? h`<span class="chip fixture" title="${provenance.note}">${icon.file}${provenance.chip}</span>`
    : h`<span class="chip live">${icon.shield}${provenance.chip}</span>`;
  const rec = d.recommendation.toLowerCase();
  const confidence = Math.round(d.confidence * 100);
  const noteCount = d.evidences.length;
  const reasoningBody = h`<p class="reasoning">${d.reasoning}</p>
    ${d.dispute_reason_understood ? h`<p class="sub understood">Understood as: ${d.dispute_reason_understood}</p>` : ""}
    ${d.deadline_note ? h`<div class="callout info">${icon.info}<div>${d.deadline_note}</div></div>` : ""}
    ${d.recommendation === "OFFER_PARTIAL" && d.offer ? h`<p>Offer: ${d.offer.offer_type.replace(/_/g, " ").toLowerCase()} of <strong class="tnum">${d.offer.amount}</strong></p>` : ""}`;
  const editBody = h`${d.evidences.map(
    (e, i) => h`<div class="note">
      <div class="note-head"><span class="chip gray">${e.evidence_type.replace(/_/g, " ").toLowerCase()}</span>${e.tracking ? h`<span class="ref">${e.tracking.carrier} ${e.tracking.number}</span>` : ""}${(e.refund_ids ?? []).map((r) => h`<span class="ref">${r}</span>`)}<span class="edited" hidden>Edited</span></div>
      <textarea name="note_${i}" maxlength="2000" rows="4" data-autogrow aria-label="Evidence note ${i + 1}">${e.notes}</textarea>
      <div class="refs">${e.source_refs.map((r) => h`<span class="ref">${r}</span>`)}</div>
    </div>`,
  )}${
    d.recommendation !== "CONTEST"
      ? h`<div class="note"><div class="note-head"><span class="chip gray">message to PayPal</span><span class="edited" hidden>Edited</span></div><textarea name="merchant_message" maxlength="2000" rows="4" data-autogrow aria-label="Message to PayPal">${d.merchant_message ?? ""}</textarea></div>`
      : ""
  }`;
  const editSummary =
    d.recommendation === "CONTEST"
      ? `${noteCount} evidence ${noteCount === 1 ? "note" : "notes"}, editable`
      : firstSentence(d.merchant_message ?? "", 90) || "Message to PayPal";
  const ledgerBody = h`<ul class="ledger">${ledger.map(
    (i) => h`<li class="led ${i.state}" data-state="${i.state}">
      <span class="led-ic">${i.state === "have" ? icon.checkCircle : i.state === "weak" ? icon.halfCircle : icon.flag}</span>
      <div><b>${i.label}</b><span class="led-detail">${i.detail}</span>${i.collect ? h`<p class="collect"><em>Collect</em>${i.collect}</p>` : ""}</div>
      <span class="led-tag">${i.state === "have" ? "Have" : i.state === "weak" ? "Weak" : "Missing"}</span></li>`,
  )}</ul>`;
  const scoreBody = h`<ul class="parts">
    ${s.breakdown.map((p) => h`<li class="part ${p.applicable ? "" : "na"}" data-part="${p.key}"><div class="part-head"><span>${p.label}</span><span class="pts tnum">${p.applicable ? h`${p.points}<i>/${p.max}</i>` : "n/a"}</span></div><span class="bar" role="img" aria-label="${p.applicable ? `${p.points} of ${p.max} points` : "Not applicable"}"><i style="--w:${p.applicable ? Math.round((p.points / p.max) * 100) : 0}%"></i></span><span class="why">${p.reason}</span></li>`)}
    ${s.penalties.map((p) => h`<li class="part pen" data-part="${p.key}"><div class="part-head"><span>Penalty: ${p.key.replace(/_/g, " ")}</span><span class="pts tnum">${p.points}</span></div><span class="why">${p.reason}</span></li>`)}
    </ul>`;
  return h`<div id="draft-panel" class="panel draft reveal">
<form id="draft-form" hx-post="/drafts/${draft.id}/preview" hx-target="#modal-slot" hx-swap="innerHTML" hx-disabled-elt="find button[type=submit]">
  <div class="draft-top"><span class="eyebrow">Agent draft · v${draft.version}</span>${sourceChip}</div>
  ${provenance.note ? h`<p class="fixture-note">${provenance.note}</p>` : ""}
  <div class="verdict ${rec}">
    <div class="verdict-text">
      <span class="eyebrow">The agent's recommendation</span>
      <h2 class="rec-title ${rec}">Recommend: ${decisionHeadline(d.recommendation, offerMoney)}</h2>
      <p class="verdict-why">${plainWords(firstSentence(d.reasoning))}</p>
    </div>
    ${contest ? gauge(draft.score, true) : ""}
  </div>
  <dl class="vstats">
    <div><dt>Confidence</dt><dd>${confidenceWord(d.confidence)} <span class="tnum">${confidence}%</span></dd></div>
    <div><dt>Expected recovery</dt><dd class="tnum">${money({ currency_code: ctx.amount.currency_code, value: recover.toFixed(2) })} <small>of ${money(ctx.amount)}</small></dd></div>
  </dl>
  ${chance !== null ? h`<p class="basis">Win chance is the evidence score, not a PayPal prediction.</p>` : ""}
  ${
    s.warnings.length > 0
      ? h`<div class="callout error">${icon.alert}<div><strong>Grounding warnings</strong><ul>${s.warnings.map((w) => h`<li>${w}</li>`)}</ul></div></div>`
      : ""
  }
  ${(d.flags ?? []).map((f) => h`<div class="callout warn">${icon.flag}<div><strong>Flagged:</strong> ${plainWords(f)}</div></div>`)}
  <div class="actions">
    <button class="btn primary big" type="submit">Review &amp; approve${icon.arrow}<span class="spinner htmx-indicator" aria-hidden="true"></span></button>
    <button class="btn danger" type="button" hx-post="/drafts/${draft.id}/reject" hx-vals='${JSON.stringify({ idempotency_key: `${ctx.idempotencyKey}-reject` })}' hx-target="#draft-panel" hx-swap="outerHTML" hx-confirm="Reject this draft? Nothing will be sent to PayPal.">Reject</button>
    <p class="hint">You see the exact ${ctx.mode === "mock" ? "(simulated) " : ""}PayPal request before anything is sent.</p>
  </div>
  <div class="details-stack">
    <h3 class="details-h">Details</h3>
    ${detailSection("Why the agent decided this", plainWords(firstSentence(d.reasoning, 80)), reasoningBody)}
    ${detailSection("Edit what gets sent", editSummary, editBody)}
    ${detailSection("Evidence ledger", h`<b class="have">${count("have")}</b> have <b class="weak">${count("weak")}</b> weak <b class="missing">${count("missing")}</b> missing`, ledgerBody)}
    ${detailSection("Score breakdown", contest ? h`Evidence score <b class="tnum">${draft.score}</b> / 100` : "Evidence score: n/a, not contesting", scoreBody)}
    ${detailSection("Tool trace", `${draft.trace.length} tool calls`, traceView(draft.trace))}
  </div>
</form></div>`;
}

const DRAFT_STEPS = [
  "Reading the dispute and buyer messages",
  "Fetching transaction, order and tracking",
  "Checking merchant policy and buyer history",
  "Drafting evidence and scoring it",
];

export function noDraftPanel(disputeId: string, error?: string): Safe {
  return h`<div id="draft-panel" class="panel empty draft-empty reveal">
  <div class="idle">
    <svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true"><rect x="22" y="10" width="76" height="76" rx="8" class="ea-sheet"/><path d="M36 30h48M36 42h48M36 54h30" class="ea-line"/><circle cx="86" cy="70" r="14" class="ea-ring ${error ? "warn" : ""}"/>${error ? raw('<path d="M86 63v8M86 76v.5" class="ea-check warn"/>') : raw('<path d="M80 70l4 4 8-9" class="ea-check"/>')}</svg>
    <h2>${error ? "The agent could not draft a response" : "Next step: draft a response"}</h2>
    ${
      error
        ? h`<div class="callout error" role="alert">${icon.alert}<div>${error}</div></div><p class="hint">Nothing was sent to PayPal.</p>`
        : h`<p>The agent reads the dispute, transaction, order and tracking, then recommends whether to accept, contest or offer a partial refund. Nothing is sent to PayPal until you approve it.</p>`
    }
    <button class="btn primary big" hx-post="/disputes/${disputeId}/draft" hx-target="#draft-panel" hx-swap="outerHTML" hx-disabled-elt="this" hx-indicator="#draft-panel">
      ${error ? "Retry" : "Draft a response"}${icon.arrow}
    </button>
  </div>
  <div class="drafting" role="status" aria-live="polite">
    <span class="eyebrow">Agent is working</span>
    <ol class="steps">${DRAFT_STEPS.map((s, i) => h`<li style="--i:${i}">${s}</li>`)}</ol>
    <div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>
  </div>
</div>`;
}

export function detailPage(ev: EvidenceView, panel: Safe, now: Date): Safe {
  const d = ev.dispute;
  const buyer = d.disputed_transactions[0]?.buyer.name;
  const due = dueWords(d.seller_response_due_date, now);
  const claim = d.messages.find((m) => m.posted_by === "BUYER");
  return h`<div class="case-page"><a class="crumb" href="/">${icon.back}All disputes</a>
<header class="case-head">
  <div class="case-head-main">
    <span class="eyebrow mono">${d.dispute_id}</span>
    <h1>${REASON_LABEL[d.reason]}</h1>
    <p class="claim-plain">${REASON_PLAIN[d.reason]}</p>
    ${claim ? h`<figure class="buyer-quote"><blockquote>${firstSentence(claim.content, 260)}</blockquote><figcaption>${buyer ?? "Buyer"}<span class="untrusted" title="Buyer-supplied text is shown as data and is never treated as an instruction by the agent.">${icon.shield}Untrusted text</span></figcaption></figure>` : ""}
  </div>
  <dl class="facts">
    <div><dt>Amount</dt><dd class="tnum">${money(d.dispute_amount)}</dd></div>
    <div><dt>Buyer</dt><dd>${buyer ?? "Unknown"}</dd></div>
    <div class="fact-due ${due.tone}"><dt>Respond by</dt><dd>${deadlineRingView(deadlineRing(d.seller_response_due_date, now), "lg")}<span class="due-text"><b>${due.text}</b><small>${dateFmt(d.seller_response_due_date)}</small></span></dd></div>
    <div class="fact-status"><dt>PayPal status</dt><dd>${statusChip(d.status)}</dd></div>
  </dl>
</header>
<div class="hero">${panel}</div>
<details class="casefile"><summary><span class="dt-title">Case file</span><span class="dt-sum">Buyer claim, transaction, order and shipment</span></summary><div class="casefile-body">${caseFile(ev, now)}</div></details></div>
<div id="modal-slot"></div>`;
}

export function previewDialog(
  draft: StoredDraft,
  payload: Payload,
  opts: {
    mode: "mock" | "sandbox";
    idempotencyKey: string;
    edits: string[];
    fields: Record<string, string>;
    amount: { currency_code: string; value: string };
    buyer: string | null;
  },
): Safe {
  const req = outboundRequest(payload, draft.dispute_id, opts.idempotencyKey, opts.mode);
  const summary = sendSummary(payload, money(opts.amount));
  return h`<dialog id="approval-dialog" class="sheet" aria-labelledby="dlg-title">
<form hx-post="/drafts/${draft.id}/approve" hx-target="#draft-panel" hx-swap="outerHTML" hx-disabled-elt="find button[type=submit]">
  <header class="sheet-head">
    <div class="sheet-kicker"><span class="eyebrow">Final check</span><span class="mode ${opts.mode}">${opts.mode.toUpperCase()}</span></div>
    <h2 id="dlg-title">Send this to PayPal?</h2>
    <p>Nothing leaves this app until you confirm below.</p>
  </header>
  <div class="sheet-body">
    <div id="approval-error" role="alert"></div>
    <section class="send-summary" aria-labelledby="sum-h">
      <h3 id="sum-h">What you are about to do</h3>
      <p class="send-head">${summary.headline}</p>
      <p class="sub">Dispute <span class="mono">${draft.dispute_id}</span>${opts.buyer ? h` · ${opts.buyer}` : ""} · ${money(opts.amount)}</p>
      <ul>${summary.points.map((p) => h`<li>${p}</li>`)}</ul>
    </section>
    ${opts.edits.length > 0 ? h`<div class="callout info">${icon.info}<div>You edited: ${opts.edits.join(", ")}. The recorded decision will be "edit" and both versions are kept.</div></div>` : h`<div class="callout ok">${icon.check}<div>Unedited agent draft.</div></div>`}
    <div class="callout irreversible" role="note">${icon.alert}<div><strong>This cannot be undone.</strong> Once PayPal receives the request you cannot edit or withdraw it.</div></div>
    ${req.notSent ? h`<div class="callout info">${icon.info}<div>${req.notSent}</div></div>` : ""}
    <h3 class="req-h">The exact request</h3>
    <div class="req">
      <div class="req-line"><span class="verb">${req.method}</span><code class="req-url">${req.url}</code></div>
      <dl class="req-headers">${req.headers.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      <div class="req-label">${req.bodyLabel}</div>
      <pre class="payload">${req.body}</pre>
    </div>
    <input type="hidden" name="idempotency_key" value="${opts.idempotencyKey}">
    <input type="hidden" name="draft_id" value="${draft.id}">
    <input type="hidden" name="draft_version" value="${draft.version}">
    ${Object.entries(opts.fields).map(([k, v]) => h`<input type="hidden" name="${k}" value="${v}">`)}
  </div>
  <footer class="sheet-foot">
    <button class="btn" type="button" autofocus onclick="this.closest('dialog').close()">Cancel</button>
    <button class="btn primary big stamp-btn" type="submit">Approve &amp; send ${icon.send}<span class="spinner htmx-indicator" aria-hidden="true"></span></button>
  </footer>
</form></dialog>
<script>(function(){var d=document.getElementById("approval-dialog");if(!d)return;d.addEventListener("click",function(e){if(e.target===d)d.close()});if(!d.open)d.showModal();})();</script>`;
}

export function errorFragment(message: string): Safe {
  return h`<div class="callout error" role="alert">${icon.alert}<div>${message}</div></div>`;
}

export function auditPage(
  rows: AuditRow[],
  chain: ChainResult,
  disputeId: string | undefined,
): Safe {
  const actorTone: Record<string, string> = {
    agent: "agent",
    human: "human",
    system: "system",
    paypal: "paypal",
  };
  return h`<div class="page-head"><div><span class="eyebrow">${disputeId ? disputeId : "All disputes"}</span><h1>Audit trail</h1><p class="lede">${disputeId ? `Events for ${disputeId}.` : "Every agent step, human decision and PayPal exchange."} Each entry hashes the one before it.</p></div>
  <div class="head-actions">${disputeId ? h`<a class="btn small ghost" href="/audit">All events</a>` : ""}<a class="btn small" href="/audit/export.json" download="audit.json">${icon.download}Export JSON</a></div></div>
<div class="verify ${chain.ok ? "ok" : "bad"}" role="status">
  <span class="verify-ic">${chain.ok ? icon.shield : icon.alert}</span>
  <div><strong>${chain.ok ? "Hash chain verified" : `Chain broken at entry #${chain.brokenAt}`}</strong>
  <span>${chain.length} entries across all disputes · <a href="/audit/verify">verify JSON</a></span></div>
</div>
${
  rows.length === 0
    ? h`<div class="panel empty"><h2>No events yet</h2><p>Syncing, drafting and approvals will appear here.</p></div>`
    : h`<ol class="timeline">${rows.map(
        (r) => h`<li data-event="${r.event}" class="ev-${actorTone[r.actor] ?? "system"}">
    <span class="when mono">${dateTimeFmt(r.ts)}</span>
    <span class="node" aria-hidden="true"></span>
    <div class="ev-body"><div class="ev-line"><span class="actor">${r.actor}</span><span class="ev">${r.event.replace(/_/g, " ")}</span>${r.dispute_id ? h`<a class="ev-link mono" href="/audit?dispute=${r.dispute_id}">${r.dispute_id}</a>` : ""}<span class="hash mono" title="${r.hash}">#${r.id} ${r.hash.slice(0, 10)}</span></div>
      <details><summary>Payload</summary><pre>${JSON.stringify(JSON.parse(r.payload_json), null, 2)}</pre></details></div>
  </li>`,
      )}</ol>`
}`;
}

import type { Payload } from "../actions/approve.js";
import type { StoredDraft } from "../agent/draft.js";
import { sameAddress } from "../agent/facts.js";
import type { AuditRow, ChainResult } from "../audit.js";
import type { Dispute, DisputeReason, Order, ToolRun, Tracking, Transaction } from "../types.js";
import { h, raw, type Safe } from "./html.js";

export const REASON_LABEL: Record<DisputeReason, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  CANCELED_RECURRING_BILLING: "Subscription cancelled",
  OTHER: "Other",
};

const STATUS: Record<string, { label: string; tone: string }> = {
  WAITING_FOR_SELLER_RESPONSE: { label: "Waiting for you", tone: "amber" },
  WAITING_FOR_BUYER_RESPONSE: { label: "Waiting for buyer", tone: "violet" },
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
  new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency_code }).format(
    Number(m.value),
  );

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

export function scoreRing(score: number, size: "sm" | "lg" = "sm"): Safe {
  const tone = score >= 80 ? "good" : score >= 50 ? "mid" : "low";
  return h`<div class="score ${tone} ${size === "lg" ? "lg" : ""}" style="--pct:${score}" data-score="${score}" role="img" aria-label="Evidence quality score ${score} out of 100"><span>${score}</span></div>`;
}

const CSRF_MARKER = "__CSRF_TOKEN__";
const csrfInput = raw(`<input type="hidden" name="csrf_token" value="${CSRF_MARKER}">`);

export interface LayoutOptions {
  title: string;
  mode: "mock" | "sandbox";
  nav: "inbox" | "audit" | "";
  now: Date;
  csrf: string;
}

export function layout(opts: LayoutOptions, body: Safe): string {
  const clockNote =
    opts.mode === "mock"
      ? h`<span class="demo-clock" title="Mock mode uses a fixed demo clock so scripted fixtures stay valid">Demo clock ${dateTimeFmt(opts.now.toISOString())}</span>`
      : "";
  return h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Dispute Copilot</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/htmx.js" defer></script>
<script>document.addEventListener("htmx:beforeSwap",function(e){var s=e.detail.xhr.status;if(s>=400&&s<600){e.detail.shouldSwap=true;e.detail.isError=false;}});</script>
</head>
<body hx-boost="false" hx-headers='{"X-CSRF-Token":"${opts.csrf}"}'>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="topbar-inner">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5L16 9.5"/></svg></span>Dispute Copilot</a>
  <nav class="nav" aria-label="Primary">
    <a href="/" ${opts.nav === "inbox" ? raw('aria-current="page"') : ""}>Inbox</a>
    <a href="/audit" ${opts.nav === "audit" ? raw('aria-current="page"') : ""}>Audit trail</a>
  </nav>
  <div class="topbar-right">${clockNote}<span class="mode ${opts.mode}">${opts.mode.toUpperCase()}</span></div>
</div></header>
<main id="main">${body}</main>
</body>
</html>`
    .toString()
    .replaceAll(CSRF_MARKER, opts.csrf);
}

export interface InboxRow {
  dispute: Dispute;
  draft: { recommendation: string; score: number; version: number } | null;
  decision: string | null;
}

export function inboxPage(rows: InboxRow[], now: Date, mode: "mock" | "sandbox"): Safe {
  const waiting = rows.filter((r) => r.dispute.status === "WAITING_FOR_SELLER_RESPONSE").length;
  const head = h`<div class="page-head">
    <div><h1>Disputes</h1><p>${rows.length} synced, ${waiting} waiting for your response.</p></div>
    <form method="post" action="/sync">${csrfInput}<button class="btn" type="submit">Sync now</button></form>
  </div>`;
  if (rows.length === 0) {
    return h`${head}<div class="card empty"><h2>No disputes yet</h2><p>Sync with ${mode === "mock" ? "the seeded mock data" : "PayPal"} to load your open disputes.</p>
      <form method="post" action="/sync">${csrfInput}<button class="btn primary" type="submit">Sync now</button></form></div>`;
  }
  const sorted = [...rows].sort((a, b) =>
    (a.dispute.seller_response_due_date ?? "9").localeCompare(
      b.dispute.seller_response_due_date ?? "9",
    ),
  );
  return h`${head}
<div class="card"><table class="table">
<thead><tr><th>Dispute</th><th>Reason</th><th class="num">Amount</th><th>Due</th><th>Status</th><th>Draft</th><th>Score</th></tr></thead>
<tbody>${sorted.map(({ dispute: d, draft, decision }) => {
    const buyer = d.disputed_transactions[0]?.buyer.name ?? "Unknown buyer";
    return h`<tr data-dispute-row>
  <td><a class="row-link" href="/disputes/${d.dispute_id}">${d.dispute_id}</a><div class="sub">${buyer}</div></td>
  <td>${REASON_LABEL[d.reason]}</td>
  <td class="num">${money(d.dispute_amount)}</td>
  <td>${timeLeft(d.seller_response_due_date, now)}</td>
  <td>${statusChip(d.status)}</td>
  <td>${
    decision
      ? h`<span class="chip plain ${decision === "reject" ? "gray" : "green"}">${decision === "reject" ? "Rejected" : "Submitted"}</span>`
      : draft
        ? h`<span class="chip plain violet">${draft.recommendation.replace("_", " ")} · v${draft.version}</span>`
        : h`<span class="sub">No draft</span>`
  }</td>
  <td>${draft ? scoreRing(draft.score) : h`<span class="sub">-</span>`}</td>
</tr>`;
  })}</tbody></table></div>`;
}

export function notFoundPage(what: string, detail: string): Safe {
  return h`<div class="card empty"><h2>${what}</h2><p>${detail}</p><a class="btn primary" href="/">Back to inbox</a></div>`;
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
  return a ? `${a.line1}, ${a.city} ${a.postal_code}, ${a.country_code}` : "Not on file";
}

function evidencePanel(ev: EvidenceView, now: Date): Safe {
  const d = ev.dispute;
  const txn = hasError(ev.transaction) ? null : ev.transaction;
  const tracking = ev.tracking && !hasError(ev.tracking) ? ev.tracking : null;
  const match =
    txn && tracking ? sameAddress(txn.shipping_address, tracking.delivery_address) : null;
  return h`
<section class="card card-pad" aria-labelledby="dispute-h">
  <div class="section-title"><h2 id="dispute-h">Dispute</h2>${statusChip(d.status)}</div>
  <dl class="kv">
    <dt>Reason</dt><dd>${REASON_LABEL[d.reason]}</dd>
    <dt>Amount</dt><dd>${money(d.dispute_amount)}</dd>
    <dt>Respond by</dt><dd>${dateFmt(d.seller_response_due_date)} · ${timeLeft(d.seller_response_due_date, now)}</dd>
    <dt>Opened</dt><dd>${dateFmt(d.create_time)}</dd>
  </dl>
  ${d.messages.map((m) => h`<div class="quote"><span class="sub">${m.posted_by === "BUYER" ? "Buyer" : "Merchant"} · ${dateFmt(m.time_posted)}</span>${m.content}</div>`)}
</section>
<section class="card card-pad" aria-labelledby="txn-h">
  <h2 id="txn-h">Transaction</h2>
  ${
    txn
      ? h`<dl class="kv">
    <dt>Transaction</dt><dd class="mono">${txn.id}</dd>
    <dt>Order</dt><dd class="mono">${txn.order_id}</dd>
    <dt>Paid</dt><dd>${money(txn.amount)} on ${dateFmt(txn.created)}</dd>
    <dt>Buyer</dt><dd>${txn.buyer.name}<div class="sub">${txn.buyer.email}</div></dd>
    <dt>Ship to</dt><dd>${addressLine(txn.shipping_address)}</dd>
    <dt>Refunds</dt><dd>${txn.refunds.length === 0 ? "None" : txn.refunds.map((r) => h`<div>${money(r.amount)} <span class="mono">${r.id}</span> on ${dateFmt(r.created)}</div>`)}</dd>
  </dl>`
      : h`<div class="callout error">Transaction unavailable: ${(ev.transaction as { error: string }).error}</div>`
  }
  ${
    ev.order && !hasError(ev.order)
      ? h`<h3 style="margin-top:16px">Order items</h3>${ev.order.items.map((i) => h`<p style="margin-top:6px"><strong>${i.quantity} × ${i.name}</strong><span class="sub"> · ${i.description}</span></p>`)}${ev.order.listing_note ? h`<div class="callout warn">Listing note: ${ev.order.listing_note}</div>` : ""}`
      : ""
  }
</section>
<section class="card card-pad" aria-labelledby="ship-h">
  <h2 id="ship-h">${txn?.access_logs ? "Access logs" : "Shipping evidence"}</h2>
  ${
    txn?.access_logs
      ? h`<table class="breakdown">${txn.access_logs.map((l) => h`<tr><td>${l.event.replace(/_/g, " ")}</td><td class="pts mono">${dateFmt(l.at)}</td></tr>`)}</table>`
      : tracking
        ? h`<dl class="kv">
    <dt>Carrier</dt><dd>${tracking.carrier} · <span class="mono">${tracking.tracking_number}</span></dd>
    <dt>Status</dt><dd>${tracking.status === "DELIVERED" ? h`<span class="ok-mark">Delivered</span>` : tracking.status === "LOST" ? h`<span class="bad-mark">Lost</span>` : tracking.status.replace("_", " ")}</dd>
    <dt>Shipped</dt><dd>${dateFmt(tracking.shipped_at)}</dd>
    <dt>Delivered</dt><dd>${dateFmt(tracking.delivered_at)}${tracking.signed_by ? ` · signed by ${tracking.signed_by}` : ""}</dd>
    <dt>Delivered to</dt><dd>${addressLine(tracking.delivery_address)}</dd>
    <dt>Address check</dt><dd>${match === null ? "Not available" : match ? h`<span class="ok-mark">Matches the transaction address</span>` : h`<span class="bad-mark">Differs from the transaction address</span>`}</dd>
  </dl>`
        : h`<div class="callout warn">No tracking on file for this transaction.${hasError(ev.tracking) ? ` (${ev.tracking.error})` : ""}</div>`
  }
</section>`;
}

function traceView(trace: ToolRun[]): Safe {
  return h`${trace.map(
    (t) =>
      h`<details class="trace"><summary><span class="mono">${t.name}</span>${t.ref ? h`<span class="ref">${t.ref}</span>` : ""}${t.is_error ? h`<span class="chip red plain">error</span>` : ""}</summary><pre>${JSON.stringify(t.output, null, 2)}</pre></details>`,
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

export function decisionPanel(
  draft: StoredDraft,
  decision: Decision,
  mode: "mock" | "sandbox",
  errorText?: string,
): Safe {
  const rejected = decision.decision === "reject";
  const a = decision.action;
  return h`<div id="draft-panel" class="card">
  <div class="block">
    <h3>Decision</h3>
    ${
      rejected
        ? h`<div class="callout info"><strong>Rejected.</strong> Nothing was sent to PayPal. Decided by ${decision.decidedBy} on ${dateTimeFmt(decision.decidedAt)}.</div>`
        : a?.status === "ok"
          ? h`<div class="callout ok"><strong>Submitted to PayPal${mode === "mock" ? " (mock)" : " sandbox"}.</strong> ${decision.decision === "edit" ? "Sent with your edits. " : ""}Dispute is now ${statusChip(String((a.response as { status?: string } | null)?.status ?? "OTHER"))}</div>
             <dl class="kv"><dt>Action</dt><dd class="mono">${a.kind}</dd><dt>PayPal-Request-Id</dt><dd class="mono">${a.request_id}</dd><dt>Attempts</dt><dd>${a.attempts}</dd></dl>
             <h3 style="margin-top:14px">PayPal response</h3><pre class="payload">${JSON.stringify(a.response, null, 2)}</pre>`
          : a?.status === "in_flight"
            ? h`<div class="callout info"><strong>Submission in progress.</strong> The request is with PayPal. Reload in a moment; it will not be sent twice.</div>`
            : h`<div class="callout error"><strong>PayPal did not accept the submission.</strong> ${errorText ?? ""} The draft is saved. Retrying reuses the same PayPal-Request-Id, so it cannot be applied twice.</div>
             <form style="margin-top:12px" hx-post="/drafts/${draft.id}/approve" hx-target="#draft-panel" hx-swap="outerHTML" hx-disabled-elt="find button">
               <input type="hidden" name="idempotency_key" value="${a?.request_id ?? ""}">
               <input type="hidden" name="draft_id" value="${draft.id}">
               <input type="hidden" name="draft_version" value="${draft.version}">
               <button class="btn primary" type="submit">Retry submission</button></form>`
    }
    <p class="hint" style="margin-top:12px"><a href="/audit?dispute=${draft.dispute_id}">View audit trail for ${draft.dispute_id}</a></p>
  </div></div>`;
}

export function draftPanel(
  draft: StoredDraft,
  ctx: { mode: "mock" | "sandbox"; idempotencyKey: string },
): Safe {
  const d = draft.draft;
  const s = draft.scoreResult;
  const recClass = d.recommendation.toLowerCase();
  const sourceChip =
    draft.source === "replayed"
      ? h`<span class="chip violet plain" title="A pre-scripted draft from fixtures/llm-cache. This is not real Claude output. Set ANTHROPIC_API_KEY to get a live model draft.">Scripted demo fixture</span>`
      : h`<span class="chip blue plain">Live ${draft.model}</span>`;
  return h`<div id="draft-panel" class="card">
<form id="draft-form" hx-post="/drafts/${draft.id}/preview" hx-target="#modal-slot" hx-swap="innerHTML" hx-disabled-elt="find button[type=submit]">
  <div class="rec">
    ${scoreRing(draft.score, "lg")}
    <div>
      <div class="rec-label">Agent recommends</div>
      <div class="rec-value ${recClass}">${d.recommendation.replace("_", " ")}</div>
      <div class="sub">Confidence ${Math.round(d.confidence * 100)}% · draft v${draft.version}</div>
    </div>
    <div class="rec-meta">${sourceChip}<span class="sub">Evidence quality score</span></div>
  </div>
  <div class="block"><h3>Reasoning</h3><p class="reasoning">${d.reasoning}</p>
    ${d.dispute_reason_understood ? h`<p class="sub" style="margin-top:6px">Understood as: ${d.dispute_reason_understood}</p>` : ""}
    ${(d.flags ?? []).map((f) => h`<div class="callout warn"><strong>Flagged:</strong> ${f}</div>`)}
    ${d.deadline_note ? h`<div class="callout info">${d.deadline_note}</div>` : ""}
  </div>
  ${
    s.warnings.length > 0
      ? h`<div class="block"><div class="callout error"><strong>Grounding warnings</strong><ul>${s.warnings.map((w) => h`<li>${w}</li>`)}</ul></div></div>`
      : ""
  }
  <div class="block"><h3>Score breakdown</h3>
    <table class="breakdown">
    ${s.breakdown.map((p) => h`<tr class="${p.applicable ? "" : "na"}"><td>${p.label}<span class="why">${p.reason}</span></td><td class="pts">${p.applicable ? `${p.points} / ${p.max}` : "n/a"}</td></tr>`)}
    ${s.penalties.map((p) => h`<tr class="pen"><td>Penalty: ${p.key.replace(/_/g, " ")}<span class="why">${p.reason}</span></td><td class="pts">${p.points}</td></tr>`)}
    </table>
  </div>
  ${
    d.recommendation === "OFFER_PARTIAL" && d.offer
      ? h`<div class="block"><h3>Offer</h3><p>${d.offer.offer_type.replace(/_/g, " ").toLowerCase()} of <strong>${d.offer.amount}</strong></p></div>`
      : ""
  }
  ${
    d.evidences.length > 0
      ? h`<div class="block"><h3>Drafted evidence</h3>
    ${d.evidences.map(
      (e, i) => h`<div class="evidence">
      <div class="evidence-head"><span class="chip gray plain">${e.evidence_type.replace(/_/g, " ").toLowerCase()}</span>${e.tracking ? h`<span class="ref">${e.tracking.carrier} ${e.tracking.number}</span>` : ""}${(e.refund_ids ?? []).map((r) => h`<span class="ref">${r}</span>`)}</div>
      <textarea name="note_${i}" readonly maxlength="2000" aria-label="Evidence note ${i + 1}">${e.notes}</textarea>
      <div class="refs">${e.source_refs.map((r) => h`<span class="ref">${r}</span>`)}</div>
    </div>`,
    )}</div>`
      : ""
  }
  ${
    d.recommendation !== "CONTEST" && d.merchant_message
      ? h`<div class="block field"><h3>Message to PayPal</h3><textarea name="merchant_message" readonly maxlength="2000" aria-label="Message to PayPal">${d.merchant_message}</textarea></div>`
      : ""
  }
  ${
    d.missing_evidence.length > 0
      ? h`<div class="block"><div class="callout warn"><strong>Missing evidence, merchant input needed</strong><ul>${d.missing_evidence.map((m) => h`<li>${m}</li>`)}</ul></div></div>`
      : ""
  }
  <div class="block"><h3>Agent tool calls (${draft.trace.length})</h3>${traceView(draft.trace)}</div>
  <div class="actions">
    <button class="btn primary" type="submit">Approve</button>
    <button class="btn" type="button" id="edit-btn" onclick="document.querySelectorAll('#draft-form textarea').forEach(function(t){t.removeAttribute('readonly')});var f=document.querySelector('#draft-form textarea');if(f)f.focus();this.disabled=true;">Edit</button>
    <span class="spinner htmx-indicator" aria-hidden="true"></span>
    <span class="spacer"></span>
    <button class="btn danger" type="button" hx-post="/drafts/${draft.id}/reject" hx-vals='${JSON.stringify({ idempotency_key: `${ctx.idempotencyKey}-reject` })}' hx-target="#draft-panel" hx-swap="outerHTML" hx-confirm="Reject this draft? Nothing will be sent to PayPal.">Reject</button>
  </div>
  <p class="hint" style="padding:0 20px 16px">Approve shows the exact request before anything is sent to PayPal${ctx.mode === "mock" ? " (mock)" : " sandbox"}.</p>
</form></div>`;
}

export function noDraftPanel(disputeId: string, error?: string): Safe {
  return h`<div id="draft-panel" class="card">
  <div class="empty">
    <h2>${error ? "The agent could not draft a response" : "No draft yet"}</h2>
    ${
      error
        ? h`<div class="callout error" style="text-align:left">${error}</div><p class="hint" style="margin-top:8px">Nothing was sent to PayPal.</p>`
        : h`<p>The agent reads the dispute, transaction, order and tracking, then drafts evidence you can edit and approve.</p>`
    }
    <button class="btn primary" hx-post="/disputes/${disputeId}/draft" hx-target="#draft-panel" hx-swap="outerHTML" hx-disabled-elt="this">
      ${error ? "Retry" : "Draft with agent"} <span class="spinner htmx-indicator" aria-hidden="true"></span>
    </button>
  </div></div>`;
}

export function detailPage(ev: EvidenceView, panel: Safe, now: Date): Safe {
  return h`<a class="crumb" href="/">← All disputes</a>
<div class="page-head"><div><h1>${ev.dispute.dispute_id}</h1><p>${REASON_LABEL[ev.dispute.reason]} · ${money(ev.dispute.dispute_amount)}</p></div></div>
<div class="layout">
  <div>${evidencePanel(ev, now)}</div>
  <div>${panel}</div>
</div>
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
  },
): Safe {
  const endpoint = `POST /v1/customer/disputes/${draft.dispute_id}/${payload.kind}`;
  return h`<dialog id="approval-dialog" aria-labelledby="dlg-title">
<form hx-post="/drafts/${draft.id}/approve" hx-target="#draft-panel" hx-swap="outerHTML" hx-disabled-elt="find button[type=submit]">
  <div class="dlg-head">
    <span class="mode ${opts.mode}">${opts.mode.toUpperCase()}</span>
    <h2 id="dlg-title" style="font-size:1.25rem;margin-top:10px">Approve and send to PayPal</h2>
    <p class="sub" style="margin-top:4px">This is the exact request that will be sent. Nothing leaves this app until you confirm.</p>
  </div>
  <div class="dlg-body">
    <div id="approval-error"></div>
    <div class="endpoint">${endpoint}</div>
    <div class="endpoint" style="margin-top:6px">PayPal-Request-Id: ${opts.idempotencyKey}</div>
    ${opts.edits.length > 0 ? h`<div class="callout info">You edited: ${opts.edits.join(", ")}. The recorded decision will be "edit" and both versions are kept.</div>` : h`<div class="callout ok">Unedited agent draft.</div>`}
    <pre class="payload">${JSON.stringify(payload.request, null, 2)}</pre>
    <input type="hidden" name="idempotency_key" value="${opts.idempotencyKey}">
    <input type="hidden" name="draft_id" value="${draft.id}">
    <input type="hidden" name="draft_version" value="${draft.version}">
    ${Object.entries(opts.fields).map(([k, v]) => h`<input type="hidden" name="${k}" value="${v}">`)}
  </div>
  <div class="dlg-foot">
    <button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button>
    <button class="btn primary" type="submit">Approve &amp; submit <span class="spinner htmx-indicator" aria-hidden="true"></span></button>
  </div>
</form></dialog>
<script>(function(){var d=document.getElementById("approval-dialog");if(d&&!d.open)d.showModal();})();</script>`;
}

export function errorFragment(message: string): Safe {
  return h`<div class="callout error" role="alert">${message}</div>`;
}

export function auditPage(
  rows: AuditRow[],
  chain: ChainResult,
  disputeId: string | undefined,
): Safe {
  const actorTone: Record<string, string> = {
    agent: "violet",
    human: "green",
    system: "gray",
    paypal: "blue",
  };
  return h`<div class="page-head"><div><h1>Audit trail</h1><p>${disputeId ? `Events for ${disputeId}.` : "Every agent step, human decision and PayPal exchange."} Each entry hashes the one before it.</p></div>
  <div style="display:flex;gap:8px">${disputeId ? h`<a class="btn small" href="/audit">All events</a>` : ""}<a class="btn small" href="/audit/export.json" download="audit.json">Export JSON</a></div></div>
<div class="card">
  <div class="verify ${chain.ok ? "ok" : "bad"}" role="status">
    <strong>${chain.ok ? "Hash chain verified" : `Chain broken at entry #${chain.brokenAt}`}</strong>
    <span>${chain.length} entries across all disputes · <a href="/audit/verify">verify JSON</a></span>
  </div>
  ${
    rows.length === 0
      ? h`<div class="empty"><h2>No events yet</h2><p>Syncing, drafting and approvals will appear here.</p></div>`
      : h`<ol class="timeline">${rows.map(
          (r) => h`<li data-event="${r.event}">
    <span class="when">${dateTimeFmt(r.ts)}</span>
    <span><span class="chip plain ${actorTone[r.actor] ?? "gray"}">${r.actor}</span></span>
    <div><span class="ev">${r.event.replace(/_/g, " ")}</span>${r.dispute_id ? h` <a class="sub" href="/audit?dispute=${r.dispute_id}">${r.dispute_id}</a>` : ""}
      <details><summary>Payload</summary><pre>${JSON.stringify(JSON.parse(r.payload_json), null, 2)}</pre></details></div>
    <span class="hash mono" title="${r.hash}">#${r.id} ${r.hash.slice(0, 10)}</span>
  </li>`,
        )}</ol>`
  }
</div>`;
}

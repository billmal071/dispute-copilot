import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  AlreadyDecidedError,
  ApprovalRequiredError,
  approveDraft,
  buildPayload,
  rejectDraft,
  StaleDraftError,
  submitApproved,
  ValidationError,
} from "./actions/approve.js";
import { createDraft, getDraft, latestDraft } from "./agent/draft.js";
import type { AppContext } from "./app.js";
import { listAudit, verifyChain } from "./audit.js";
import { PayPalError } from "./paypal/client.js";
import { withDisputeBuyer } from "./paypal/mappers.js";
import { syncDisputes } from "./sync.js";
import type { Dispute, EvidenceDraft } from "./types.js";
import { h } from "./web/html.js";
import { icon } from "./web/icons.js";
import { type PageMeta, pageMeta, type RouteKey } from "./web/insight.js";
import {
  auditPage,
  type Decision,
  decisionPanel,
  detailPage,
  draftPanel,
  type EvidenceView,
  errorFragment,
  type InboxRow,
  inboxPage,
  layout,
  noDraftPanel,
  notFoundPage,
  previewDialog,
} from "./web/views.js";
import { handleWebhook } from "./webhook.js";

const ROOT = join(import.meta.dirname, "..");
const DECIDER = "merchant@local";
const CSRF_FIELD = "csrf_token";

const STATIC_FILES: [route: string, file: string, type: string][] = [
  ["/favicon.svg", "icons/favicon.svg", "image/svg+xml"],
  ["/favicon.ico", "icons/favicon.ico", "image/x-icon"],
  ["/apple-touch-icon.png", "icons/apple-touch-icon.png", "image/png"],
  ["/icon-192.png", "icons/icon-192.png", "image/png"],
  ["/icon-512.png", "icons/icon-512.png", "image/png"],
  ["/assets/grain.png", "icons/grain.png", "image/png"],
  ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
];

const readAsset = (path: string) => readFileSync(join(ROOT, path), "utf8");

interface DecisionRow {
  decision: Decision["decision"];
  decided_by: string;
  decided_at: string;
  kind: string | null;
  status: string | null;
  attempts: number | null;
  response_json: string | null;
  paypal_request_id: string | null;
}

function loadDecision(ctx: AppContext, draftId: number): Decision | null {
  const row = ctx.db
    .prepare(
      `SELECT a.decision, a.decided_by, a.decided_at, x.kind, x.status, x.attempts, x.response_json, x.paypal_request_id
       FROM approvals a LEFT JOIN actions x ON x.approval_id = a.id WHERE a.draft_id = ?`,
    )
    .get(draftId) as DecisionRow | undefined;
  if (!row) return null;
  return {
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    action: row.kind
      ? {
          kind: row.kind,
          status: row.status ?? "pending",
          attempts: row.attempts ?? 0,
          response: row.response_json ? JSON.parse(row.response_json) : null,
          request_id: row.paypal_request_id ?? "",
        }
      : null,
  };
}

function localDispute(ctx: AppContext, id: string): Dispute | null {
  const row = ctx.db.prepare("SELECT raw_json FROM disputes WHERE paypal_id = ?").get(id) as
    | { raw_json: string }
    | undefined;
  return row ? (JSON.parse(row.raw_json) as Dispute) : null;
}

export function applyEdits(
  draft: EvidenceDraft,
  form: Record<string, unknown>,
): { edited: EvidenceDraft; changed: string[] } {
  const edited = structuredClone(draft);
  const changed: string[] = [];
  edited.evidences.forEach((e, i) => {
    const value = form[`note_${i}`];
    if (typeof value === "string" && value.trim() !== e.notes) {
      e.notes = value.trim();
      changed.push(`evidence note ${i + 1}`);
    }
  });
  const message = form.merchant_message;
  if (typeof message === "string" && message.trim() !== (draft.merchant_message ?? "")) {
    edited.merchant_message = message.trim();
    changed.push("message to PayPal");
  }
  return { edited, changed };
}

function passthroughFields(form: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(form).filter(
      ([k, v]) => (/^note_\d+$/.test(k) || k === "merchant_message") && typeof v === "string",
    ) as [string, string][],
  );
}

const CSRF_COOKIE = "dc_csrf";
const CSRF_EXEMPT = new Set(["/webhooks/paypal"]);

function csrfGuard(secret: Buffer) {
  const sign = (id: string) => createHmac("sha256", secret).update(id).digest("base64url");
  const valid = (token: string | undefined): token is string => {
    const [id, mac] = token?.split(".") ?? [];
    if (!id || !mac) return false;
    const expected = Buffer.from(sign(id));
    const actual = Buffer.from(mac);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const mint = () => {
    const id = randomBytes(18).toString("base64url");
    return `${id}.${sign(id)}`;
  };
  return { valid, mint };
}

export type Server = Hono<{ Variables: { csrf: string } }>;

export function createServer(ctx: AppContext): Server {
  const app: Server = new Hono();
  const csrf = csrfGuard(randomBytes(32));
  const page = (
    c: { get(key: "csrf"): string },
    meta: PageMeta | RouteKey,
    nav: "inbox" | "audit" | "",
    body: ReturnType<typeof h>,
    id?: string,
  ) =>
    layout(
      {
        meta: typeof meta === "string" ? pageMeta(meta, id ? { id } : {}) : meta,
        mode: ctx.mode,
        nav,
        now: ctx.clock.now(),
        csrf: c.get("csrf"),
      },
      body,
    );
  const auditFor = (disputeId: string) => listAudit(ctx.db, disputeId).slice(-3);

  app.use("*", async (c, next) => {
    const existing = getCookie(c, CSRF_COOKIE);
    const token = csrf.valid(existing) ? existing : csrf.mint();
    c.set("csrf", token);
    if (token !== existing)
      setCookie(c, CSRF_COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/" });
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || CSRF_EXEMPT.has(c.req.path)) return next();

    const reject = (why: string) => c.json({ error: `Request blocked: ${why}` }, 403);
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return reject("cross-site request");
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== new URL(c.req.url).host) return reject("cross-origin request");
    }
    if (existing !== token) return reject("missing session");
    let submitted = c.req.header("x-csrf-token");
    if (!submitted) {
      const type = c.req.header("content-type") ?? "";
      if (type.includes("form")) {
        const field = (await c.req.parseBody())[CSRF_FIELD];
        submitted = typeof field === "string" ? field : undefined;
      }
    }
    if (submitted !== token) return reject("missing or invalid CSRF token");
    return next();
  });
  const isHtmx = (c: { req: { header(name: string): string | undefined } }) =>
    c.req.header("hx-request") === "true";

  app.get("/assets/htmx.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    c.header("cache-control", "public, max-age=86400");
    return c.body(readAsset("node_modules/htmx.org/dist/htmx.min.js"));
  });
  app.get("/assets/app.css", (c) => {
    c.header("content-type", "text/css; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(readAsset("public/app.css"));
  });
  app.get("/assets/app.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(readAsset("public/app.js"));
  });
  app.get("/assets/fonts/:file", (c) => {
    const file = c.req.param("file");
    if (!/^[a-z0-9-]+\.woff2$/.test(file)) return c.notFound();
    const path = join(ROOT, "public", "fonts", file);
    if (!existsSync(path)) return c.notFound();
    c.header("content-type", "font/woff2");
    c.header("cache-control", "public, max-age=31536000, immutable");
    return c.body(readFileSync(path));
  });
  for (const [route, file, type] of STATIC_FILES) {
    app.get(route, (c) => {
      c.header("content-type", type);
      c.header("cache-control", "public, max-age=86400");
      return c.body(readFileSync(join(ROOT, "public", file)));
    });
  }
  app.get("/healthz", (c) => c.json({ ok: true, mode: ctx.mode }));

  app.get("/", (c) => {
    const disputes = (
      ctx.db.prepare("SELECT raw_json FROM disputes").all() as { raw_json: string }[]
    ).map((r) => JSON.parse(r.raw_json) as Dispute);
    const rows: InboxRow[] = disputes.map((dispute) => {
      const draft = latestDraft(ctx.db, dispute.dispute_id);
      const decision = draft ? loadDecision(ctx, draft.id) : null;
      return {
        dispute,
        draft: draft
          ? {
              recommendation: draft.draft.recommendation,
              score: draft.score,
              version: draft.version,
              offerAmount: draft.draft.offer ? Number(draft.draft.offer.amount) : null,
            }
          : null,
        decision: decision?.decision ?? null,
      };
    });
    return c.html(page(c, "inbox", "inbox", inboxPage(rows, ctx.clock.now(), ctx.mode)));
  });

  app.post("/sync", async (c) => {
    try {
      await syncDisputes(ctx);
    } catch (err) {
      const message = err instanceof PayPalError ? err.message : String(err);
      return c.html(
        page(
          c,
          {
            title: "Sync failed",
            description:
              "Dispute Copilot could not reach PayPal to sync disputes. Your last synced disputes, drafts and audit trail are still available.",
          },
          "inbox",
          h`<div class="panel empty"><h2>PayPal unavailable</h2><div class="callout error" role="alert">${icon.alert}<div>${message}</div></div><p class="hint">Showing the last synced data. Your drafts are saved.</p><a class="btn primary" href="/">Back to inbox</a></div>`,
        ),
        502,
      );
    }
    return c.redirect("/", 303);
  });

  app.get("/disputes/:id", async (c) => {
    const id = c.req.param("id");
    let dispute: Dispute | null = null;
    let loadError: string | null = null;
    try {
      dispute = await ctx.reader.getDispute(id);
    } catch (err) {
      if (err instanceof PayPalError && err.status === 404) {
        return c.html(
          page(
            c,
            "notfound",
            "inbox",
            notFoundPage("Dispute not found", `PayPal has no dispute with id ${id}.`),
          ),
          404,
        );
      }
      loadError = err instanceof Error ? err.message : String(err);
      dispute = localDispute(ctx, id);
    }
    if (!dispute) {
      return c.html(
        page(
          c,
          "error",
          "inbox",
          notFoundPage("PayPal unavailable", loadError ?? "The dispute could not be loaded."),
        ),
        502,
      );
    }
    const txnId = dispute.disputed_transactions[0]?.seller_transaction_id ?? "";
    const settle = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
      try {
        return await fn();
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };
    const transaction = await settle(async () =>
      withDisputeBuyer(await ctx.reader.getTransaction(txnId), dispute),
    );
    const order =
      "error" in transaction || !transaction.order_id
        ? null
        : await settle(() => ctx.reader.getOrder(transaction.order_id));
    const tracking = await settle(() => ctx.reader.getTracking(txnId));
    const view: EvidenceView = { dispute, transaction, order, tracking };

    const draft = latestDraft(ctx.db, id);
    const decision = draft ? loadDecision(ctx, draft.id) : null;
    const panel = !draft
      ? noDraftPanel(id)
      : decision
        ? decisionPanel(draft, decision, ctx.mode, undefined, auditFor(id))
        : draftPanel(draft, {
            mode: ctx.mode,
            idempotencyKey: randomUUID(),
            amount: dispute.dispute_amount,
          });
    const banner = loadError
      ? h`<div class="callout warn">PayPal is unavailable (${loadError}). Showing the last synced copy of this dispute.</div>`
      : "";
    return c.html(
      page(
        c,
        "dispute",
        "inbox",
        h`${banner}${detailPage(view, panel, ctx.clock.now())}`,
        dispute.dispute_id,
      ),
    );
  });

  app.post("/disputes/:id/draft", async (c) => {
    const id = c.req.param("id");
    if (!localDispute(ctx, id)) {
      return c.html(
        page(
          c,
          "notfound",
          "inbox",
          notFoundPage("Dispute not found", `No synced dispute with id ${id}.`),
        ),
        404,
      );
    }
    const outcome = await createDraft(ctx, id);
    if (!isHtmx(c)) return c.redirect(`/disputes/${id}`, 303);
    return c.html(
      outcome.state === "ok"
        ? draftPanel(outcome.draft, {
            mode: ctx.mode,
            idempotencyKey: randomUUID(),
            amount: (localDispute(ctx, id) as Dispute).dispute_amount,
          }).toString()
        : noDraftPanel(id, outcome.error).toString(),
    );
  });

  app.post("/drafts/:id/preview", async (c) => {
    const stored = getDraft(ctx.db, Number(c.req.param("id")));
    if (!stored) return c.html(errorFragment("Draft not found.").toString(), 404);
    const form = await c.req.parseBody();
    const dispute = localDispute(ctx, stored.dispute_id);
    if (!dispute) return c.html(errorFragment("Dispute is not synced locally.").toString(), 404);
    const { edited, changed } = applyEdits(stored.draft, form);
    try {
      const payload = buildPayload(dispute, edited);
      return c.html(
        previewDialog(stored, payload, {
          mode: ctx.mode,
          idempotencyKey: randomUUID(),
          edits: changed,
          fields: passthroughFields(form),
        }).toString(),
      );
    } catch (err) {
      if (err instanceof ValidationError) return c.html(errorFragment(err.message).toString(), 422);
      throw err;
    }
  });

  const approvalDeps = () => ({ db: ctx.db, writer: ctx.writer, clock: ctx.clock });

  app.post("/drafts/:id/approve", async (c) => {
    const draftId = Number(c.req.param("id"));
    const stored = getDraft(ctx.db, draftId);
    if (!stored) return c.html(errorFragment("Draft not found.").toString(), 404);
    const form = await c.req.parseBody();
    const key =
      typeof form.idempotency_key === "string" && form.idempotency_key
        ? form.idempotency_key
        : `draft-${draftId}-${randomUUID()}`;
    const { edited } = applyEdits(stored.draft, form);
    const draftVersion = Number(form.draft_version);
    if (!Number.isInteger(draftVersion) || Number(form.draft_id) !== draftId)
      return c.html(
        errorFragment(
          "This approval did not say which draft version you reviewed. Reload the page.",
        ).toString(),
        409,
      );
    try {
      const outcome = await approveDraft(approvalDeps(), {
        draftId,
        idempotencyKey: key,
        decidedBy: DECIDER,
        draftVersion,
        edited,
      });
      if (!isHtmx(c)) return c.redirect(`/disputes/${stored.dispute_id}`, 303);
      const decision = loadDecision(ctx, draftId);
      if (!decision) throw new Error("decision missing after approval");
      return c.html(
        decisionPanel(
          stored,
          decision,
          ctx.mode,
          outcome.error,
          auditFor(stored.dispute_id),
        ).toString(),
      );
    } catch (err) {
      if (err instanceof ValidationError) {
        c.header("HX-Retarget", "#approval-error");
        c.header("HX-Reswap", "innerHTML");
        return c.html(errorFragment(err.message).toString(), 422);
      }
      if (err instanceof StaleDraftError) return c.html(errorFragment(err.message).toString(), 409);
      if (err instanceof AlreadyDecidedError) {
        const decision = loadDecision(ctx, draftId);
        return c.html(
          decision
            ? decisionPanel(
                stored,
                decision,
                ctx.mode,
                undefined,
                auditFor(stored.dispute_id),
              ).toString()
            : errorFragment(err.message).toString(),
          409,
        );
      }
      throw err;
    }
  });

  app.post("/drafts/:id/reject", async (c) => {
    const draftId = Number(c.req.param("id"));
    const stored = getDraft(ctx.db, draftId);
    if (!stored) return c.html(errorFragment("Draft not found.").toString(), 404);
    const form = await c.req.parseBody();
    const key =
      typeof form.idempotency_key === "string" && form.idempotency_key
        ? form.idempotency_key
        : `reject-${draftId}-${randomUUID()}`;
    try {
      await rejectDraft(approvalDeps(), { draftId, idempotencyKey: key, decidedBy: DECIDER });
    } catch (err) {
      if (!(err instanceof AlreadyDecidedError)) throw err;
    }
    const decision = loadDecision(ctx, draftId);
    if (!decision)
      return c.html(
        errorFragment(
          "That request key was already used for another decision. Reload and try again.",
        ).toString(),
        409,
      );
    if (!isHtmx(c)) return c.redirect(`/disputes/${stored.dispute_id}`, 303);
    return c.html(
      decisionPanel(stored, decision, ctx.mode, undefined, auditFor(stored.dispute_id)).toString(),
    );
  });

  app.post("/drafts/:id/submit", async (c) => {
    try {
      const outcome = await submitApproved(approvalDeps(), Number(c.req.param("id")));
      return c.json({ status: outcome.status, duplicate: outcome.duplicate });
    } catch (err) {
      if (err instanceof ApprovalRequiredError) return c.json({ error: err.message }, 403);
      if (err instanceof ValidationError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  app.get("/audit", (c) => {
    const dispute = c.req.query("dispute") || undefined;
    return c.html(
      page(
        c,
        "audit",
        "audit",
        auditPage(listAudit(ctx.db, dispute).reverse(), verifyChain(ctx.db), dispute),
      ),
    );
  });
  app.get("/audit/verify", (c) => c.json(verifyChain(ctx.db)));
  app.get("/audit/export.json", (c) => {
    c.header("content-disposition", 'attachment; filename="audit.json"');
    return c.json({
      exported_at: ctx.clock.now().toISOString(),
      verification: verifyChain(ctx.db),
      entries: listAudit(ctx.db).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) })),
    });
  });

  app.post("/webhooks/paypal", async (c) => {
    const event = await c.req.json().catch(() => null);
    const headers = Object.fromEntries(
      [...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]),
    );
    const out = await handleWebhook(
      { db: ctx.db, reader: ctx.reader, clock: ctx.clock, verify: ctx.verify },
      { headers, event },
    );
    if (out.status === "rejected")
      return c.json({ error: out.reason }, out.reason.includes("signature") ? 401 : 400);
    if (out.status === "accepted") void out.processing;
    return c.json({ status: out.status });
  });

  app.notFound((c) =>
    c.html(
      page(c, "notfound", "", notFoundPage("Page not found", "That page does not exist.")),
      404,
    ),
  );
  app.onError((err, c) => {
    console.error(err);
    return c.html(
      page(
        c,
        "error",
        "",
        notFoundPage(
          "Something went wrong",
          "The error was logged. Your drafts and audit trail are unaffected.",
        ),
      ),
      500,
    );
  });
  return app;
}

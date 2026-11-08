import { getDraft } from "../agent/draft.js";
import { appendAudit } from "../audit.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import {
  type AcceptClaimRequest,
  type MakeOfferRequest,
  PayPalError,
  type PayPalWriteClient,
  type ProvideEvidenceRequest,
} from "../paypal/client.js";
import { type Dispute, EvidenceDraft } from "../types.js";

export interface ApprovalDeps {
  db: Db;
  writer: PayPalWriteClient;
  clock: Clock;
}

export class ApprovalRequiredError extends Error {
  readonly status = 403;
  constructor(draftId: number) {
    super(`Draft ${draftId} has no human approval; nothing was sent to PayPal.`);
    this.name = "ApprovalRequiredError";
  }
}

export class AlreadyDecidedError extends Error {
  readonly status = 409;
  constructor(draftId: number) {
    super(`Draft ${draftId} already has a decision.`);
    this.name = "AlreadyDecidedError";
  }
}

export class StaleDraftError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "StaleDraftError";
  }
}

export class ValidationError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type ActionKind = "provide-evidence" | "accept-claim" | "make-offer";

export type Payload =
  | { kind: "provide-evidence"; request: ProvideEvidenceRequest }
  | { kind: "accept-claim"; request: AcceptClaimRequest }
  | { kind: "make-offer"; request: MakeOfferRequest };

const MAX_NOTES = 2000;

export function buildPayload(dispute: Dispute, draft: EvidenceDraft): Payload {
  const note = (draft.merchant_message ?? draft.reasoning).slice(0, MAX_NOTES);
  switch (draft.recommendation) {
    case "CONTEST": {
      if (draft.evidences.length === 0)
        throw new ValidationError("A contest needs at least one evidence item.");
      for (const e of draft.evidences) {
        if (e.notes.length < 1 || e.notes.length > MAX_NOTES) {
          throw new ValidationError(`Evidence notes must be 1 to ${MAX_NOTES} characters.`);
        }
      }
      return {
        kind: "provide-evidence",
        request: {
          evidences: draft.evidences.map((e) => ({
            evidence_type: e.evidence_type,
            notes: e.notes,
            ...(e.tracking || e.refund_ids?.length
              ? {
                  evidence_info: {
                    ...(e.tracking
                      ? {
                          tracking_info: [
                            {
                              carrier_name: e.tracking.carrier,
                              tracking_number: e.tracking.number,
                            },
                          ],
                        }
                      : {}),
                    ...(e.refund_ids?.length ? { refund_ids: e.refund_ids } : {}),
                  },
                }
              : {}),
          })),
        },
      };
    }
    case "ACCEPT":
      return {
        kind: "accept-claim",
        request: { note, accept_claim_reason: draft.accept_reason ?? "REASON_NOT_SET" },
      };
    case "OFFER_PARTIAL": {
      if (!draft.offer)
        throw new ValidationError("A partial offer needs an offer type and amount.");
      if (!(Number(draft.offer.amount) > 0))
        throw new ValidationError("The offer amount must be positive.");
      return {
        kind: "make-offer",
        request: {
          note,
          offer_amount: {
            currency_code: dispute.dispute_amount.currency_code,
            value: draft.offer.amount,
          },
          offer_type: draft.offer.offer_type,
        },
      };
    }
  }
}

export interface ApprovalOutcome {
  approvalId: number;
  actionId: number;
  status: "ok" | "failed" | "in_flight";
  duplicate: boolean;
  response?: unknown;
  error?: string;
}

interface ApprovalRow {
  id: number;
  draft_id: number;
  decision: "approve" | "reject" | "edit";
  edited_json: string | null;
  idempotency_key: string;
}

interface ActionRow {
  id: number;
  approval_id: number;
  kind: ActionKind;
  request_json: string;
  response_json: string | null;
  status: "pending" | "in_flight" | "ok" | "failed";
  attempts: number;
  paypal_request_id: string;
}

function loadDispute(db: Db, paypalId: string): Dispute {
  const row = db.prepare("SELECT raw_json FROM disputes WHERE paypal_id = ?").get(paypalId) as
    | { raw_json: string }
    | undefined;
  if (!row) throw new ValidationError(`Dispute ${paypalId} is not synced locally.`);
  return JSON.parse(row.raw_json) as Dispute;
}

function loadDraftOrThrow(db: Db, draftId: number) {
  const draft = getDraft(db, draftId);
  if (!draft) throw new ValidationError(`Draft ${draftId} does not exist.`);
  return draft;
}

function changedFields(original: EvidenceDraft, edited: EvidenceDraft): string[] {
  const changed: string[] = [];
  if (original.recommendation !== edited.recommendation) changed.push("recommendation");
  if (JSON.stringify(original.evidences) !== JSON.stringify(edited.evidences))
    changed.push("evidences");
  if (JSON.stringify(original.offer) !== JSON.stringify(edited.offer)) changed.push("offer");
  if (original.merchant_message !== edited.merchant_message) changed.push("merchant_message");
  return changed;
}

async function execute(
  deps: ApprovalDeps,
  action: ActionRow,
  disputeId: string,
): Promise<ApprovalOutcome> {
  const { db, writer, clock } = deps;
  const ts = () => clock.now().toISOString();
  const request = JSON.parse(action.request_json) as Payload["request"];
  const claimed = db
    .prepare(
      "UPDATE actions SET status = 'in_flight', attempts = attempts + 1 WHERE id = ? AND status IN ('pending','failed')",
    )
    .run(action.id);
  if (claimed.changes === 0) {
    const current = actionFor(db, action.approval_id);
    return {
      approvalId: current.approval_id,
      actionId: current.id,
      status: current.status === "ok" ? "ok" : "in_flight",
      duplicate: true,
      response: current.response_json ? JSON.parse(current.response_json) : undefined,
    };
  }
  appendAudit(db, {
    actor: "system",
    event: "outbound_request",
    disputeId,
    payload: {
      kind: action.kind,
      paypal_request_id: action.paypal_request_id,
      attempt: action.attempts + 1,
      request,
    },
    ts: ts(),
  });
  try {
    const response =
      action.kind === "provide-evidence"
        ? await writer.provideEvidence(
            disputeId,
            request as ProvideEvidenceRequest,
            action.paypal_request_id,
          )
        : action.kind === "accept-claim"
          ? await writer.acceptClaim(
              disputeId,
              request as AcceptClaimRequest,
              action.paypal_request_id,
            )
          : await writer.makeOffer(
              disputeId,
              request as MakeOfferRequest,
              action.paypal_request_id,
            );
    db.prepare(
      "UPDATE actions SET status = 'ok', response_json = ? WHERE id = ? AND status = 'in_flight'",
    ).run(JSON.stringify(response), action.id);
    db.prepare("UPDATE disputes SET status = ?, updated_at = ? WHERE paypal_id = ?").run(
      response.status,
      ts(),
      disputeId,
    );
    appendAudit(db, {
      actor: "paypal",
      event: "outbound_response",
      disputeId,
      payload: { kind: action.kind, response },
      ts: ts(),
    });
    return {
      approvalId: action.approval_id,
      actionId: action.id,
      status: "ok",
      duplicate: false,
      response,
    };
  } catch (err) {
    const message = err instanceof PayPalError ? `${err.code}: ${err.message}` : String(err);
    db.prepare(
      "UPDATE actions SET status = 'failed', response_json = ? WHERE id = ? AND status = 'in_flight'",
    ).run(JSON.stringify({ error: message }), action.id);
    appendAudit(db, {
      actor: "paypal",
      event: "outbound_error",
      disputeId,
      payload: { kind: action.kind, error: message },
      ts: ts(),
    });
    return {
      approvalId: action.approval_id,
      actionId: action.id,
      status: "failed",
      duplicate: false,
      error: message,
    };
  }
}

function actionFor(db: Db, approvalId: number): ActionRow {
  return db.prepare("SELECT * FROM actions WHERE approval_id = ?").get(approvalId) as ActionRow;
}

export interface DecisionInput {
  draftId: number;
  idempotencyKey: string;
  decidedBy: string;
  draftVersion: number;
  edited?: EvidenceDraft;
}

export async function approveDraft(
  deps: ApprovalDeps,
  input: DecisionInput,
): Promise<ApprovalOutcome> {
  const { db, clock } = deps;
  const draft = loadDraftOrThrow(db, input.draftId);
  const disputeId = draft.dispute_id;

  const prior = db
    .prepare("SELECT * FROM approvals WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as ApprovalRow | undefined;
  if (prior) {
    if (prior.draft_id !== input.draftId || prior.decision === "reject")
      throw new AlreadyDecidedError(input.draftId);
    const action = actionFor(db, prior.id);
    if (action.status === "ok") {
      return {
        approvalId: prior.id,
        actionId: action.id,
        status: "ok",
        duplicate: true,
        response: JSON.parse(action.response_json ?? "null"),
      };
    }
    return execute(deps, action, disputeId);
  }
  if (db.prepare("SELECT 1 FROM approvals WHERE draft_id = ?").get(input.draftId))
    throw new AlreadyDecidedError(input.draftId);
  if (input.draftVersion !== draft.version)
    throw new StaleDraftError(
      `The preview showed draft v${input.draftVersion} but this is draft v${draft.version}. Reload and review again.`,
    );
  const newest = db
    .prepare("SELECT MAX(version) AS v FROM drafts WHERE dispute_id = ?")
    .get(disputeId) as { v: number };
  if (newest.v !== draft.version)
    throw new StaleDraftError(
      `Draft v${draft.version} was superseded by v${newest.v}. Reload and review the latest draft.`,
    );
  if (
    db
      .prepare(
        `SELECT 1 FROM approvals a JOIN drafts d ON d.id = a.draft_id
         WHERE d.dispute_id = ? AND a.decision IN ('approve','edit')`,
      )
      .get(disputeId)
  )
    throw new AlreadyDecidedError(input.draftId);

  const parsedEdit = input.edited ? EvidenceDraft.safeParse(input.edited) : null;
  if (parsedEdit && !parsedEdit.success)
    throw new ValidationError(`Edited draft is invalid: ${parsedEdit.error.message}`);
  const edited = parsedEdit?.data;
  const effective = edited ?? draft.draft;
  const payload = buildPayload(loadDispute(db, disputeId), effective);
  const decidedAt = clock.now().toISOString();
  const decision = edited && changedFields(draft.draft, edited).length > 0 ? "edit" : "approve";

  const action = db.transaction((): ActionRow => {
    const approval = db
      .prepare(
        "INSERT INTO approvals (draft_id, decision, edited_json, decided_by, decided_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.draftId,
        decision,
        decision === "edit" ? JSON.stringify(edited) : null,
        input.decidedBy,
        decidedAt,
        input.idempotencyKey,
      );
    const approvalId = Number(approval.lastInsertRowid);
    const inserted = db
      .prepare(
        "INSERT INTO actions (approval_id, kind, request_json, status, attempts, paypal_request_id) VALUES (?, ?, ?, 'pending', 0, ?)",
      )
      .run(approvalId, payload.kind, JSON.stringify(payload.request), input.idempotencyKey);
    appendAudit(db, {
      actor: "human",
      event: "human_decision",
      disputeId,
      payload: {
        decision,
        draft_id: input.draftId,
        decided_by: input.decidedBy,
        changed: edited ? changedFields(draft.draft, edited) : [],
        idempotency_key: input.idempotencyKey,
      },
      ts: decidedAt,
    });
    return db
      .prepare("SELECT * FROM actions WHERE id = ?")
      .get(Number(inserted.lastInsertRowid)) as ActionRow;
  })();

  return execute(deps, action, disputeId);
}

export async function rejectDraft(
  deps: ApprovalDeps,
  input: Omit<DecisionInput, "edited" | "draftVersion">,
): Promise<{ approvalId: number }> {
  const { db, clock } = deps;
  const draft = loadDraftOrThrow(db, input.draftId);
  if (db.prepare("SELECT 1 FROM approvals WHERE draft_id = ?").get(input.draftId))
    throw new AlreadyDecidedError(input.draftId);
  const decidedAt = clock.now().toISOString();
  return db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO approvals (draft_id, decision, edited_json, decided_by, decided_at, idempotency_key) VALUES (?, 'reject', NULL, ?, ?, ?)",
      )
      .run(input.draftId, input.decidedBy, decidedAt, input.idempotencyKey);
    appendAudit(db, {
      actor: "human",
      event: "human_decision",
      disputeId: draft.dispute_id,
      payload: { decision: "reject", draft_id: input.draftId, decided_by: input.decidedBy },
      ts: decidedAt,
    });
    return { approvalId: Number(info.lastInsertRowid) };
  })();
}

export async function submitApproved(
  deps: ApprovalDeps,
  draftId: number,
): Promise<ApprovalOutcome> {
  const { db, clock } = deps;
  const draft = loadDraftOrThrow(db, draftId);
  const approval = db
    .prepare("SELECT * FROM approvals WHERE draft_id = ? AND decision IN ('approve','edit')")
    .get(draftId) as ApprovalRow | undefined;
  if (!approval) {
    appendAudit(db, {
      actor: "system",
      event: "submit_blocked",
      disputeId: draft.dispute_id,
      payload: { draft_id: draftId, reason: "no human approval on record" },
      ts: clock.now().toISOString(),
    });
    throw new ApprovalRequiredError(draftId);
  }
  const action = actionFor(db, approval.id);
  if (action.status === "ok") {
    return {
      approvalId: approval.id,
      actionId: action.id,
      status: "ok",
      duplicate: true,
      response: JSON.parse(action.response_json ?? "null"),
    };
  }
  return execute(deps, action, draft.dispute_id);
}

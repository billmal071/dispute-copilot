import type { Db } from "../db.js";
import type { Scenario } from "../seed/scenarios.js";
import type { Dispute, DisputeFilter, Order, Tracking, Transaction } from "../types.js";
import {
  type AcceptClaimRequest,
  type ActionResponse,
  type MakeOfferRequest,
  type PayPalClient,
  PayPalError,
  type ProvideEvidenceRequest,
} from "./client.js";

interface MockRecord {
  dispute: Dispute;
  evidences: unknown[];
  offer?: unknown;
}

const MAX_NOTES = 2000;
const MAX_DOCUMENTS = 100;

function linksFor(dispute: Dispute): Dispute["links"] {
  const base = `https://api-m.sandbox.paypal.com/v1/customer/disputes/${dispute.dispute_id}`;
  const link = (rel: string, method: string, suffix = "") => ({
    href: `${base}${suffix}`,
    rel,
    method,
  });
  const links = [link("self", "GET")];
  if (dispute.status === "WAITING_FOR_SELLER_RESPONSE") {
    links.push(
      link("provide-evidence", "POST", "/provide-evidence"),
      link("accept-claim", "POST", "/accept-claim"),
      link("make-offer", "POST", "/make-offer"),
    );
  }
  if (dispute.status === "UNDER_REVIEW") {
    links.push(
      link("require-evidence", "POST", "/require-evidence"),
      link("adjudicate", "POST", "/adjudicate"),
    );
  }
  return links;
}

export function seedMock(db: Db, scenarios: Scenario[]): void {
  const reset = db.transaction(() => {
    db.prepare("DELETE FROM mock_disputes").run();
    db.prepare("DELETE FROM mock_requests").run();
    const insert = db.prepare("INSERT INTO mock_disputes (id, json) VALUES (?, ?)");
    for (const s of scenarios) {
      const dispute = { ...s.dispute, links: linksFor(s.dispute) };
      const record: MockRecord = { dispute, evidences: [] };
      insert.run(dispute.dispute_id, JSON.stringify(record));
    }
  });
  reset();
}

export class MockPayPal implements PayPalClient {
  writeCount = 0;

  constructor(
    private readonly db: Db,
    private readonly scenarios: Scenario[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  private load(id: string): MockRecord {
    const row = this.db.prepare("SELECT json FROM mock_disputes WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    if (!row)
      throw new PayPalError(
        404,
        "RESOURCE_NOT_FOUND",
        "The specified resource does not exist.",
        "INVALID_RESOURCE_ID",
      );
    return JSON.parse(row.json) as MockRecord;
  }

  private save(record: MockRecord): void {
    record.dispute.update_time = this.now().toISOString();
    record.dispute.links = linksFor(record.dispute);
    this.db
      .prepare("UPDATE mock_disputes SET json = ? WHERE id = ?")
      .run(JSON.stringify(record), record.dispute.dispute_id);
  }

  async listDisputes(filter: DisputeFilter = {}): Promise<Dispute[]> {
    const rows = this.db.prepare("SELECT json FROM mock_disputes ORDER BY id").all() as {
      json: string;
    }[];
    return rows
      .map((r) => (JSON.parse(r.json) as MockRecord).dispute)
      .filter((d) => !filter.status || d.status === filter.status)
      .filter((d) => !filter.updatedAfter || d.update_time > filter.updatedAfter);
  }

  async getDispute(id: string): Promise<Dispute> {
    return this.load(id).dispute;
  }

  private scenarioForTransaction(id: string): Scenario {
    const s = this.scenarios.find((x) => x.transaction.id === id);
    if (!s)
      throw new PayPalError(
        404,
        "RESOURCE_NOT_FOUND",
        "The specified resource does not exist.",
        "INVALID_RESOURCE_ID",
      );
    return s;
  }

  async getTransaction(id: string): Promise<Transaction> {
    return this.scenarioForTransaction(id).transaction;
  }

  async getOrder(id: string): Promise<Order> {
    const s = this.scenarios.find((x) => x.order.id === id);
    if (!s)
      throw new PayPalError(
        404,
        "RESOURCE_NOT_FOUND",
        "The specified resource does not exist.",
        "INVALID_RESOURCE_ID",
      );
    return s.order;
  }

  async getTracking(transactionId: string): Promise<Tracking | null> {
    return this.scenarioForTransaction(transactionId).tracking;
  }

  private idempotent(
    requestId: string,
    endpoint: string,
    run: () => ActionResponse,
  ): ActionResponse {
    const prior = this.db
      .prepare("SELECT endpoint, response_json FROM mock_requests WHERE request_id = ?")
      .get(requestId) as { endpoint: string; response_json: string } | undefined;
    if (prior) {
      if (prior.endpoint !== endpoint) {
        throw new PayPalError(
          409,
          "DUPLICATE_REQUEST_ID",
          "PayPal-Request-Id was already used for a different request.",
        );
      }
      return JSON.parse(prior.response_json) as ActionResponse;
    }
    const response = run();
    this.writeCount += 1;
    this.db
      .prepare("INSERT INTO mock_requests (request_id, endpoint, response_json) VALUES (?, ?, ?)")
      .run(requestId, endpoint, JSON.stringify(response));
    return response;
  }

  private requireStatus(record: MockRecord, status: Dispute["status"]): void {
    if (record.dispute.status !== status) {
      throw new PayPalError(
        422,
        "UNPROCESSABLE_ENTITY",
        `Dispute is ${record.dispute.status}; this action needs ${status}.`,
        "DISPUTE_STATUS_NOT_VALID",
      );
    }
  }

  private respond(record: MockRecord): ActionResponse {
    return {
      id: record.dispute.dispute_id,
      status: record.dispute.status,
      links: record.dispute.links,
    };
  }

  async provideEvidence(
    id: string,
    req: ProvideEvidenceRequest,
    requestId: string,
  ): Promise<ActionResponse> {
    return this.idempotent(requestId, `provide-evidence:${id}`, () => {
      const record = this.load(id);
      this.requireStatus(record, "WAITING_FOR_SELLER_RESPONSE");
      if (req.evidences.length === 0) {
        throw new PayPalError(
          400,
          "INVALID_REQUEST",
          "At least one evidence is required.",
          "MISSING_REQUIRED_PARAMETER",
        );
      }
      if (req.evidences.length + (req.files?.length ?? 0) > MAX_DOCUMENTS) {
        throw new PayPalError(
          400,
          "INVALID_REQUEST",
          "Too many evidence documents.",
          "INVALID_ARRAY_MAX_ITEMS",
        );
      }
      for (const e of req.evidences) {
        if (e.notes.length < 1 || e.notes.length > MAX_NOTES) {
          throw new PayPalError(
            400,
            "INVALID_REQUEST",
            "Evidence notes must be 1 to 2000 characters.",
            "INVALID_STRING_LENGTH",
          );
        }
      }
      record.evidences.push(...req.evidences);
      record.dispute.status = "UNDER_REVIEW";
      record.dispute.dispute_state = "UNDER_PAYPAL_REVIEW";
      this.save(record);
      return this.respond(record);
    });
  }

  async acceptClaim(
    id: string,
    req: AcceptClaimRequest,
    requestId: string,
  ): Promise<ActionResponse> {
    return this.idempotent(requestId, `accept-claim:${id}`, () => {
      const record = this.load(id);
      this.requireStatus(record, "WAITING_FOR_SELLER_RESPONSE");
      if (!req.note || req.note.length > MAX_NOTES) {
        throw new PayPalError(
          400,
          "INVALID_REQUEST",
          "Note must be 1 to 2000 characters.",
          "INVALID_STRING_LENGTH",
        );
      }
      record.dispute.status = "RESOLVED";
      record.dispute.dispute_state = "RESOLVED";
      record.dispute.dispute_outcome = { outcome_code: "RESOLVED_BUYER_FAVOR" };
      this.save(record);
      return this.respond(record);
    });
  }

  async makeOffer(id: string, req: MakeOfferRequest, requestId: string): Promise<ActionResponse> {
    return this.idempotent(requestId, `make-offer:${id}`, () => {
      const record = this.load(id);
      this.requireStatus(record, "WAITING_FOR_SELLER_RESPONSE");
      if (Number(req.offer_amount.value) > Number(record.dispute.dispute_amount.value)) {
        throw new PayPalError(
          422,
          "UNPROCESSABLE_ENTITY",
          "Offer cannot exceed the disputed amount.",
          "OFFER_AMOUNT_EXCEEDS_DISPUTE",
        );
      }
      record.offer = req;
      record.dispute.status = "WAITING_FOR_BUYER_RESPONSE";
      this.save(record);
      return this.respond(record);
    });
  }

  async sendMessage(id: string, message: string, requestId: string): Promise<ActionResponse> {
    return this.idempotent(requestId, `send-message:${id}`, () => {
      const record = this.load(id);
      record.dispute.messages.push({
        posted_by: "SELLER",
        time_posted: this.now().toISOString(),
        content: message,
      });
      this.save(record);
      return this.respond(record);
    });
  }

  async sandboxRequireEvidence(id: string): Promise<ActionResponse> {
    const record = this.load(id);
    this.requireStatus(record, "UNDER_REVIEW");
    record.dispute.status = "WAITING_FOR_SELLER_RESPONSE";
    this.save(record);
    return this.respond(record);
  }

  async sandboxAdjudicate(
    id: string,
    outcome: "BUYER_FAVOR" | "SELLER_FAVOR",
  ): Promise<ActionResponse> {
    const record = this.load(id);
    this.requireStatus(record, "UNDER_REVIEW");
    record.dispute.status = "RESOLVED";
    record.dispute.dispute_outcome = { outcome_code: `RESOLVED_${outcome}` };
    this.save(record);
    return this.respond(record);
  }
}

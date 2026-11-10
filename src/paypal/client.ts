import type {
  AcceptReason,
  Dispute,
  DisputeFilter,
  EvidenceType,
  Money,
  Order,
  Tracking,
  Transaction,
} from "../types.js";

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issue?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export interface ReadOnlyPayPalClient {
  listDisputes(filter?: DisputeFilter): Promise<Dispute[]>;
  getDispute(id: string): Promise<Dispute>;
  getTransaction(id: string): Promise<Transaction>;
  getOrder(id: string): Promise<Order>;
  getTracking(transactionId: string): Promise<Tracking | null>;
}

export interface EvidencePayload {
  evidence_type: EvidenceType;
  notes: string;
  evidence_info?: {
    tracking_info?: {
      carrier_name: string;
      carrier_name_other?: string;
      tracking_number: string;
    }[];
    refund_ids?: string[];
  };
}

export interface EvidenceFile {
  name: string;
  contentType: string;
  data: Uint8Array;
}

export interface ProvideEvidenceRequest {
  evidences: EvidencePayload[];
  files?: EvidenceFile[];
}

export interface AcceptClaimRequest {
  note: string;
  accept_claim_reason: AcceptReason;
}

export interface MakeOfferRequest {
  note: string;
  offer_amount: Money;
  offer_type:
    | "REFUND"
    | "REFUND_WITH_RETURN"
    | "REFUND_WITH_REPLACEMENT"
    | "REPLACEMENT_WITHOUT_REFUND";
}

export interface ActionResponse {
  id: string;
  status: string;
  links: { href: string; rel: string; method: string }[];
}

export interface PayPalWriteClient {
  provideEvidence(
    id: string,
    req: ProvideEvidenceRequest,
    requestId: string,
  ): Promise<ActionResponse>;
  acceptClaim(id: string, req: AcceptClaimRequest, requestId: string): Promise<ActionResponse>;
  makeOffer(id: string, req: MakeOfferRequest, requestId: string): Promise<ActionResponse>;
  sendMessage(id: string, message: string, requestId: string): Promise<ActionResponse>;
}

export interface SandboxHelpers {
  sandboxRequireEvidence(id: string): Promise<ActionResponse>;
  sandboxAdjudicate(id: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR"): Promise<ActionResponse>;
}

export interface PayPalClient extends ReadOnlyPayPalClient, PayPalWriteClient, SandboxHelpers {}

export function readOnly(client: ReadOnlyPayPalClient): ReadOnlyPayPalClient {
  return {
    listDisputes: (f) => client.listDisputes(f),
    getDispute: (id) => client.getDispute(id),
    getTransaction: (id) => client.getTransaction(id),
    getOrder: (id) => client.getOrder(id),
    getTracking: (id) => client.getTracking(id),
  };
}

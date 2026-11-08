import type { Dispute, DisputeFilter, Order, Tracking, Transaction } from "../types.js";
import {
  type AcceptClaimRequest,
  type ActionResponse,
  type MakeOfferRequest,
  type PayPalClient,
  PayPalError,
  type ProvideEvidenceRequest,
} from "./client.js";
import { mapDispute, mapOrder, mapTracking, mapTransaction } from "./mappers.js";

const BASE_URL = "https://api-m.sandbox.paypal.com";
const READ_SCOPE = "https://uri.paypal.com/services/disputes/read-seller";
const UPDATE_SCOPE = "https://uri.paypal.com/services/disputes/update-seller";
const BACKOFF_MS = [250, 500, 1000];
const MAX_CONCURRENCY = 2;

export interface SandboxOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  json?: unknown;
  form?: FormData;
  requestId?: string;
  scope?: string;
}

export class SandboxPayPal implements PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;
  private active = 0;
  private waiters: (() => void)[] = [];
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: SandboxOptions) {
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENCY) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
    } catch {
      throw new PayPalError(
        503,
        "PAYPAL_UNAVAILABLE",
        "PayPal unavailable while requesting an access token.",
      );
    }
    if (!res.ok) {
      throw new PayPalError(
        res.status,
        "TOKEN_FAILURE",
        `PayPal rejected the client credentials (HTTP ${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for the sandbox app.`,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async request(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    await this.acquire();
    try {
      return await this.send(method, path, opts);
    } finally {
      this.release();
    }
  }

  private async send(method: string, path: string, opts: RequestOptions): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, v);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers({
        Authorization: `Bearer ${await this.accessToken()}`,
        Accept: "application/json",
      });
      if (opts.requestId) headers.set("PayPal-Request-Id", opts.requestId);
      let body: BodyInit | undefined;
      if (opts.form) body = opts.form;
      else if (opts.json !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(opts.json);
      }
      let res: Response | null = null;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
      } catch {
        res = null;
      }
      if (res && res.status === 401 && !refreshed) {
        refreshed = true;
        await this.accessToken(true);
        attempt -= 1;
        continue;
      }
      const retryable = res === null || res.status === 429 || res.status >= 500;
      if (retryable) {
        const delay = BACKOFF_MS[attempt];
        if (delay === undefined) {
          throw new PayPalError(
            res?.status ?? 503,
            "PAYPAL_UNAVAILABLE",
            "PayPal unavailable after retries; the draft is saved and can be retried.",
          );
        }
        await this.sleep(delay);
        continue;
      }
      if (!res) throw new PayPalError(503, "PAYPAL_UNAVAILABLE", "PayPal unavailable.");
      return res;
    }
  }

  private async failure(res: Response, scope: string): Promise<PayPalError> {
    const body = (await res.json().catch(() => ({}))) as {
      name?: string;
      message?: string;
      details?: { issue?: string }[];
    };
    if (res.status === 403) {
      return new PayPalError(
        403,
        body.name ?? "NOT_AUTHORIZED",
        `PayPal refused the request. The app token needs the scope ${scope} and the Customer disputes add-on enabled.`,
      );
    }
    return new PayPalError(
      res.status,
      body.name ?? "PAYPAL_ERROR",
      body.message ?? `PayPal returned HTTP ${res.status}`,
      body.details?.[0]?.issue,
    );
  }

  private async getJson(path: string, opts: RequestOptions = {}): Promise<Record<string, any>> {
    const res = await this.request("GET", path, opts);
    if (!res.ok) throw await this.failure(res, opts.scope ?? READ_SCOPE);
    return (await res.json()) as Record<string, any>;
  }

  async listDisputes(filter: DisputeFilter = {}): Promise<Dispute[]> {
    const body = await this.getJson("/v1/customer/disputes", {
      query: {
        dispute_state: filter.status,
        update_time_after: filter.updatedAfter,
        page_size: "50",
      },
    });
    const ids = ((body.items ?? []) as { dispute_id: string }[]).map((i) => i.dispute_id);
    return Promise.all(ids.map((id) => this.getDispute(id)));
  }

  async getDispute(id: string): Promise<Dispute> {
    return mapDispute(await this.getJson(`/v1/customer/disputes/${encodeURIComponent(id)}`));
  }

  async getTransaction(id: string): Promise<Transaction> {
    const capture = await this.getJson(`/v2/payments/captures/${encodeURIComponent(id)}`);
    const orderId = capture.supplementary_data?.related_ids?.order_id as string | undefined;
    const order = orderId
      ? await this.getJson(`/v2/checkout/orders/${encodeURIComponent(orderId)}`)
      : null;
    return mapTransaction(capture, order);
  }

  async getOrder(id: string): Promise<Order> {
    return mapOrder(await this.getJson(`/v2/checkout/orders/${encodeURIComponent(id)}`));
  }

  async getTracking(transactionId: string): Promise<Tracking | null> {
    const res = await this.request("GET", "/v1/shipping/trackers", {
      query: { transaction_id: transactionId },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.failure(res, READ_SCOPE);
    const body = (await res.json()) as { trackers?: Record<string, any>[] };
    const first = body.trackers?.[0];
    return first ? mapTracking(transactionId, first) : null;
  }

  private async post(path: string, id: string, opts: RequestOptions): Promise<ActionResponse> {
    const res = await this.request("POST", path, { ...opts, scope: UPDATE_SCOPE });
    if (!res.ok) throw await this.failure(res, UPDATE_SCOPE);
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      links?: ActionResponse["links"];
    };
    return { id, status: body.status ?? "SUBMITTED", links: body.links ?? [] };
  }

  async provideEvidence(
    id: string,
    req: ProvideEvidenceRequest,
    requestId: string,
  ): Promise<ActionResponse> {
    const form = new FormData();
    form.set(
      "input",
      new Blob([JSON.stringify({ evidences: req.evidences })], { type: "application/json" }),
      "input.json",
    );
    for (const file of req.files ?? []) {
      form.append(
        "evidence-file",
        new Blob([file.data as BlobPart], { type: file.contentType }),
        file.name,
      );
    }
    return this.post(`/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, id, {
      form,
      requestId,
    });
  }

  acceptClaim(id: string, req: AcceptClaimRequest, requestId: string): Promise<ActionResponse> {
    return this.post(`/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, id, {
      json: req,
      requestId,
    });
  }

  makeOffer(id: string, req: MakeOfferRequest, requestId: string): Promise<ActionResponse> {
    return this.post(`/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`, id, {
      json: req,
      requestId,
    });
  }

  sendMessage(id: string, message: string, requestId: string): Promise<ActionResponse> {
    return this.post(`/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, id, {
      json: { message },
      requestId,
    });
  }

  sandboxRequireEvidence(id: string): Promise<ActionResponse> {
    return this.post(`/v1/customer/disputes/${encodeURIComponent(id)}/require-evidence`, id, {
      json: { action: "SELLER_EVIDENCE" },
    });
  }

  sandboxAdjudicate(id: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR"): Promise<ActionResponse> {
    return this.post(`/v1/customer/disputes/${encodeURIComponent(id)}/adjudicate`, id, {
      json: { adjudication_outcome: outcome },
    });
  }

  async verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    event: unknown,
    webhookId: string,
  ): Promise<boolean> {
    const res = await this.request("POST", "/v1/notifications/verify-webhook-signature", {
      json: {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    if (!res.ok) return false;
    return (
      ((await res.json()) as { verification_status?: string }).verification_status === "SUCCESS"
    );
  }
}

# Unverified PayPal assumptions

All isolated in `src/paypal/real.ts` and `src/paypal/mappers.ts`. Items under "Confirmed" were checked against the real PayPal sandbox on 2026-11-10 (read-only calls, plus one provide-evidence write, one dispute); everything else is still unverified.

## Confirmed against the real sandbox

- Token scopes: `read-seller` is enough for `GET /v1/customer/disputes` and `GET /v1/customer/disputes/{id}`; `GET /v2/payments/captures/{id}` also works with the same token.
- A payment with no linked order: the capture has no `order_id`, so the transaction is assembled without an order call. Buyer id and name come from the dispute's `disputed_transactions[0].buyer`; email, shipping address and refunds are blank/null/empty. The UI shows these as "Not available".
- `GET /v1/shipping/trackers?transaction_id=` returned no tracker for this transaction (treated as "no tracking on file").
- End-to-end read path: inbox, case view, scripted-fixture draft and audit hash chain verify all work on the real dispute.

- Token scopes: the app's client-credentials token carries `disputes/update-seller` and `provide-evidence` succeeded with it.
- provide-evidence without files: `POST /v1/customer/disputes/{id}/provide-evidence` with `Content-Type: application/json` and body `{evidences:[{evidence_type, notes, evidence_info:{tracking_info:[{carrier_name, carrier_name_other, tracking_number}]}}]}` returned 200 `{"status":"SUBMITTED"}`. The dispute moved WAITING_FOR_SELLER_RESPONSE to UNDER_REVIEW and the `provide_evidence`, `accept_claim`, `make_offer`, `escalate` and `send_message` links disappeared.
- For a MERCHANDISE_OR_SERVICE_NOT_RECEIVED inquiry that requested PROOF_OF_FULFILLMENT, evidence type `OTHER` was rejected with 400 `INVALID_REQUEST` / `EVIDENCE_TYPE_IS_NOT_ALLOWED`. A multipart request whose `input` part was sent by Node's FormData (with a filename) was also rejected with 400 `INVALID_REQUEST`; the detail was not captured, so the cause (filename or evidence type) is unknown.
- `PayPal-Request-Id` on provide-evidence: sent on every attempt; a different id was used after each 400 and no duplicate evidence resulted. Deduplication on a repeated id was not tested.

## Still unverified

- `GET /v1/customer/disputes` list items are fetched one by one via the detail endpoint.
- `disputed_transactions[].buyer.payer_id` as the buyer id (not checked against the raw response; the mapper falls back to the buyer name when `payer_id` is absent).
- Transaction is assembled from `GET /v2/payments/captures/{id}` plus the order (`supplementary_data.related_ids.order_id`); refunds come from `purchase_units[0].payments.refunds`.
- Tracking: `GET /v1/shipping/trackers?transaction_id=`; PayPal trackers carry no delivery time, signature or delivery address, so delivery verification will not pass in sandbox until a carrier lookup exists.
- provide-evidence with files: multipart with a JSON part named `input` and files as `evidence-file`. Not exercised; the JSON-only path is confirmed.
- accept-claim body `accept_claim_reason` enum values; make-offer body shape.
- require-evidence `{action: "SELLER_EVIDENCE"}` and adjudicate `{adjudication_outcome}` bodies.
- Webhook verification via `POST /v1/notifications/verify-webhook-signature`.
- Mock error codes (for example `DISPUTE_STATUS_NOT_VALID`) are plausible, not copied from PayPal.
- `PayPal-Request-Id` honoured on dispute endpoints (provide-evidence, accept-claim, make-offer): the in-flight claim and retry-under-same-key design assume PayPal deduplicates on it for these calls.
- Write endpoints other than provide-evidence (accept-claim, make-offer, send-message, require-evidence, adjudicate) have not been called against the real sandbox.
- Dispute `evidences[]` entries with `source: REQUESTED_FROM_SELLER` list the evidence types PayPal accepts; the app does not read them yet, so a draft can still choose a type PayPal rejects with `EVIDENCE_TYPE_IS_NOT_ALLOWED`.
- Tracker carriers from PayPal are already carrier codes; a free-text carrier is sent as `OTHER` plus `carrier_name_other`, which was accepted once with a placeholder carrier.
- A tracker that does exist for a transaction: the real sandbox returned none, so tracker mapping is untested against real data.

# Unverified PayPal assumptions

All isolated in `src/paypal/real.ts` and `src/paypal/mappers.ts`. Items under "Confirmed" were checked against the real PayPal sandbox on 2026-11-10 (read-only calls, one dispute); everything else is still unverified.

## Confirmed against the real sandbox (read-only)

- Token scopes: `read-seller` is enough for `GET /v1/customer/disputes` and `GET /v1/customer/disputes/{id}`; `GET /v2/payments/captures/{id}` also works with the same token.
- A payment with no linked order: the capture has no `order_id`, so the transaction is assembled without an order call. Buyer id and name come from the dispute's `disputed_transactions[0].buyer`; email, shipping address and refunds are blank/null/empty. The UI shows these as "Not available".
- `GET /v1/shipping/trackers?transaction_id=` returned no tracker for this transaction (treated as "no tracking on file").
- End-to-end read path: inbox, case view, scripted-fixture draft and audit hash chain verify all work on the real dispute.

## Still unverified


- Token scopes: whether `update-seller` suffices for the write endpoints (only `read-seller` is confirmed).
- `GET /v1/customer/disputes` list items are fetched one by one via the detail endpoint.
- `disputed_transactions[].buyer.payer_id` as the buyer id (not checked against the raw response; the mapper falls back to the buyer name when `payer_id` is absent).
- Transaction is assembled from `GET /v2/payments/captures/{id}` plus the order (`supplementary_data.related_ids.order_id`); refunds come from `purchase_units[0].payments.refunds`.
- Tracking: `GET /v1/shipping/trackers?transaction_id=`; PayPal trackers carry no delivery time, signature or delivery address, so delivery verification will not pass in sandbox until a carrier lookup exists.
- provide-evidence multipart: JSON part named `input`, files as `evidence-file`.
- accept-claim body `accept_claim_reason` enum values; make-offer body shape.
- require-evidence `{action: "SELLER_EVIDENCE"}` and adjudicate `{adjudication_outcome}` bodies.
- Webhook verification via `POST /v1/notifications/verify-webhook-signature`.
- Mock error codes (for example `DISPUTE_STATUS_NOT_VALID`) are plausible, not copied from PayPal.
- `PayPal-Request-Id` honoured on dispute endpoints (provide-evidence, accept-claim, make-offer): the in-flight claim and retry-under-same-key design assume PayPal deduplicates on it for these calls.
- Every write endpoint (provide-evidence, accept-claim, make-offer, send-message, require-evidence, adjudicate) has not been called against the real sandbox.
- A tracker that does exist for a transaction: the real sandbox returned none, so tracker mapping is untested against real data.

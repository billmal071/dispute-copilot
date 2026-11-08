# Unverified PayPal assumptions

All isolated in `src/paypal/real.ts` and `src/paypal/mappers.ts`. Confirm in the first sandbox smoke test.

- Token scopes: whether `read-seller` / `update-seller` suffice for a default sandbox app.
- `GET /v1/customer/disputes` list items are fetched one by one via the detail endpoint.
- `disputed_transactions[].buyer.payer_id` as the buyer id.
- Transaction is assembled from `GET /v2/payments/captures/{id}` plus the order (`supplementary_data.related_ids.order_id`); refunds come from `purchase_units[0].payments.refunds`.
- Tracking: `GET /v1/shipping/trackers?transaction_id=`; PayPal trackers carry no delivery time, signature or delivery address, so delivery verification will not pass in sandbox until a carrier lookup exists.
- provide-evidence multipart: JSON part named `input`, files as `evidence-file`.
- accept-claim body `accept_claim_reason` enum values; make-offer body shape.
- require-evidence `{action: "SELLER_EVIDENCE"}` and adjudicate `{adjudication_outcome}` bodies.
- Webhook verification via `POST /v1/notifications/verify-webhook-signature`.
- Mock error codes (for example `DISPUTE_STATUS_NOT_VALID`) are plausible, not copied from PayPal.
- `PayPal-Request-Id` honoured on dispute endpoints (provide-evidence, accept-claim, make-offer): the in-flight claim and retry-under-same-key design assume PayPal deduplicates on it for these calls.
